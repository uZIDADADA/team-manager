import unittest
import json
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from unittest.mock import MagicMock, patch

import worker


class FetchPayloadTests(unittest.TestCase):
    def test_accepts_supported_chatgpt_request(self):
        parsed = worker.parse_fetch_payload(
            {
                "method": "post",
                "path": "/backend-api/accounts/workspace/users",
                "headers": {"Authorization": "Bearer token"},
                "body": "{}",
                "proxy": " http://proxy.example:8080 ",
            }
        )

        self.assertEqual(parsed["method"], "POST")
        self.assertEqual(parsed["path"], "/backend-api/accounts/workspace/users")
        self.assertEqual(parsed["base_url"], worker.BASE_URL)
        self.assertEqual(parsed["proxy"], "http://proxy.example:8080")

    def test_accepts_codex_oauth_token_exchange(self):
        parsed = worker.parse_fetch_payload(
            {
                "method": "POST",
                "baseUrl": "https://auth.openai.com",
                "path": "/oauth/token",
                "headers": {"Content-Type": "application/x-www-form-urlencoded"},
                "body": "grant_type=authorization_code",
            }
        )

        self.assertEqual(parsed["base_url"], worker.CODEX_AUTH_BASE_URL)

    def test_rejects_unknown_upstream_base_url(self):
        with self.assertRaisesRegex(ValueError, "unsupported upstream base URL"):
            worker.parse_fetch_payload(
                {"method": "GET", "baseUrl": "https://example.com", "path": "/secret"}
            )

    def test_rejects_external_or_protocol_relative_paths(self):
        for path in [
            "//example.com/secret", "///example.com/secret",
            "/http://127.0.0.1/secret", "/https://example.com/secret",
            "/HTTP://127.0.0.1/secret", "/file:///etc/passwd",
            "/\\example.com/secret", "/\n/127.0.0.1/secret",
            "/\t/127.0.0.1/secret", "/backend-api/me#fragment",
        ]:
            with self.subTest(path=path), self.assertRaises(ValueError):
                worker.parse_fetch_payload({"method": "GET", "path": path})

    def test_preserves_valid_paths_queries_and_origins(self):
        for base in [worker.BASE_URL, worker.CODEX_AUTH_BASE_URL]:
            for path in ["/", "/backend-api/me?offset=0&limit=100", "/oauth/token",
                         "/backend-api/%2F%2Fexample.com", "/?next=https://example.com"]:
                with self.subTest(base=base, path=path):
                    self.assertEqual(worker.upstream_url(base, path), base.rstrip("/") + path)

    def test_does_not_trust_lookalike_origins(self):
        for base in ["https://chatgpt.com.example.com", "https://chatgpt.com@127.0.0.1",
                     "http://chatgpt.com", "https://chatgpt.com:8443"]:
            with self.subTest(base=base), self.assertRaises(ValueError):
                worker.parse_fetch_payload({"method": "GET", "baseUrl": base, "path": "/"})

    def test_invalid_url_never_reaches_transport(self):
        with patch.object(worker, "wire_traced_curl") as create_curl:
            with self.assertRaises(ValueError):
                worker.fetch_upstream({"base_url": worker.BASE_URL, "path": "/http://127.0.0.1/"})
            create_curl.assert_not_called()

    def test_rejects_unsupported_methods(self):
        with self.assertRaisesRegex(ValueError, "unsupported method"):
            worker.parse_fetch_payload({"method": "PUT", "path": "/backend-api/me"})


class FetchChatGptTests(unittest.TestCase):
    def test_forwards_request_with_per_account_proxy(self):
        response = MagicMock(status_code=200, text='{"ok":true}')
        response.url = "https://chatgpt.com/backend-api/me"
        response.headers.multi_items.return_value = [
            ("content-type", "application/json"),
            ("set-cookie", "first=1"),
            ("set-cookie", "second=2"),
        ]
        response.request.method = "GET"
        response.request.url = "https://chatgpt.com/backend-api/me"
        response.request.headers.multi_items.return_value = [("Authorization", "Bearer token")]
        response.request.body = None
        response.http_version = 2
        response.primary_ip = "104.18.0.1"
        response.primary_port = 443
        response.local_ip = "10.0.0.2"
        response.local_port = 45123
        response.redirect_count = 0
        response.request_size = 256
        response.response_size = 512
        response.upload_size = 0
        response.download_size = 128
        session = MagicMock()
        session.__enter__.return_value = session
        session.__exit__.return_value = None
        session.request.return_value = response
        fake_curl = MagicMock()

        with (
            patch.object(worker, "wire_traced_curl", return_value=(fake_curl, [])),
            patch.object(worker.requests, "Session", return_value=session) as create_session,
        ):
            result = worker.fetch_upstream(
                {
                    "method": "GET",
                    "path": "/backend-api/me",
                    "base_url": worker.BASE_URL,
                    "headers": {"Authorization": "Bearer token"},
                    "body": None,
                    "proxy": "http://proxy.example:8080",
                }
            )

        self.assertEqual(
            result,
            {
                "status": 200,
                "body": '{"ok":true}',
                "headers": [
                    ["content-type", "application/json"],
                    ["set-cookie", "first=1"],
                    ["set-cookie", "second=2"],
                ],
                "url": "https://chatgpt.com/backend-api/me",
                "request": {
                    "method": "GET",
                    "url": "https://chatgpt.com/backend-api/me",
                    "headers": [["Authorization", "Bearer token"]],
                },
                "network": {
                    "httpVersion": 2,
                    "primaryIp": "104.18.0.1",
                    "primaryPort": 443,
                    "localIp": "10.0.0.2",
                    "localPort": 45123,
                    "redirectCount": 0,
                    "requestSize": 256,
                    "responseSize": 512,
                    "uploadSize": 0,
                    "downloadSize": 128,
                },
                "wire": [],
            },
        )
        create_session.assert_called_once_with(
            curl=fake_curl,
            impersonate=worker.IMPERSONATE,
            verify=True,
            proxy="http://proxy.example:8080",
        )
        session.request.assert_called_once_with(
            "GET", worker.BASE_URL.rstrip("/") + "/backend-api/me",
            headers={"Authorization": "Bearer token"}, data=None,
            timeout=worker.REQUEST_TIMEOUT, allow_redirects=False,
        )

    def test_wraps_transport_failures_with_the_complete_wire_trace(self):
        wire = [{"type": "diagnostic", "data": "Trying proxy.example:8080...\n"}]
        session = MagicMock()
        session.__enter__.return_value = session
        session.__exit__.return_value = None
        session.request.side_effect = RuntimeError("proxy connect reset")

        with (
            patch.object(worker, "wire_traced_curl", return_value=(MagicMock(), wire)),
            patch.object(worker.requests, "Session", return_value=session),
        ):
            with self.assertRaises(worker.UpstreamFetchError) as raised:
                worker.fetch_upstream(
                    {
                        "method": "GET",
                        "path": "/backend-api/me",
                        "base_url": worker.BASE_URL,
                        "headers": {},
                        "body": None,
                        "proxy": "http://proxy.example:8080",
                    }
                )

        self.assertEqual(str(raised.exception.cause), "proxy connect reset")
        self.assertEqual(raised.exception.wire, wire)


@contextmanager
def local_server(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


class WorkerSecurityTests(unittest.TestCase):
    def test_unauthenticated_requests_never_read_body_or_fetch(self):
        handler = MagicMock(path="/fetch")
        for auth in [None, "Bearer wrong", "", "Bearer 非法"]:
            handler.headers = {} if auth is None else {"Authorization": auth}
            with self.subTest(auth=auth), patch.object(worker, "WORKER_TOKEN", "a" * 43):
                worker.WorkerHandler.do_POST(handler)
                handler.write_json.assert_called_with(401, {"error": "unauthorized"})
                handler.read_json.assert_not_called()

    def test_missing_or_weak_token_fails_closed(self):
        for token in ["", "short", "a" * 31, "a" * 32 + "\n"]:
            with self.subTest(token=token), patch.object(worker, "WORKER_TOKEN", token):
                with patch.object(worker, "ThreadingHTTPServer") as server:
                    with self.assertRaisesRegex(ValueError, "TEAMMGR_CURL_CFFI_TOKEN"):
                        worker.main()
                    server.assert_not_called()
                handler = MagicMock(path="/fetch")
                worker.WorkerHandler.do_POST(handler)
                handler.write_json.assert_called_with(503, {"error": "worker_auth_not_configured"})
                handler.read_json.assert_not_called()

    def test_authenticated_http_request_forwards_without_worker_token(self):
        token = "test-worker-token-" + "a" * 32
        with patch.object(worker, "WORKER_TOKEN", token), local_server(worker.WorkerHandler) as server:
            for headers, status in [({}, 401), ({"Authorization": "Bearer wrong"}, 401),
                                    ({"Authorization": f"Bearer {token}"}, 200)]:
                with self.subTest(status=status), patch.object(worker, "fetch_upstream", return_value={"status": 200, "body": "ok"}) as fetch:
                    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                    try:
                        connection.request("POST", "/fetch", json.dumps({"method": "GET", "path": "/backend-api/me"}), headers)
                        response = connection.getresponse()
                        self.assertEqual(response.status, status)
                        response.read()
                    finally:
                        connection.close()
                    if status == 200:
                        self.assertEqual(fetch.call_args.args[0]["headers"], {})
                    else:
                        fetch.assert_not_called()

    def test_real_curl_does_not_follow_redirects(self):
        visited = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                visited.append(self.path)
                self.send_response(int(self.path.removeprefix("/")) if self.path != "/private" else 200)
                self.send_header("Location", "/private")
                self.send_header("Content-Length", "0")
                self.end_headers()

        with local_server(Handler) as server:
            base = f"http://127.0.0.1:{server.server_port}/"
            with patch.object(worker, "ALLOWED_BASE_URLS", {base}), patch.object(worker, "PROXY_URL", ""):
                for status in [301, 302, 303, 307, 308]:
                    with self.subTest(status=status):
                        result = worker.fetch_upstream({"method": "GET", "base_url": base,
                            "path": f"/{status}", "headers": {}, "body": None, "proxy": None})
                        self.assertEqual(result["status"], status)
                        self.assertEqual(result["network"]["redirectCount"], 0)
            self.assertEqual(visited, ["/301", "/302", "/303", "/307", "/308"])


if __name__ == "__main__":
    unittest.main()
