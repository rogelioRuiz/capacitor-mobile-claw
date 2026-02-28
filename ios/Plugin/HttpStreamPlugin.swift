import Foundation
import Capacitor

@objc(HttpStreamPlugin)
public class HttpStreamPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {
    public let identifier = "HttpStreamPlugin"
    public let jsName = "HttpStream"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "stream", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise)
    ]

    private var activeSessions: [String: URLSession] = [:]
    private var activeCalls: [String: CAPPluginCall] = [:]
    private var activeTasks: [String: URLSessionDataTask] = [:]

    @objc func stream(_ call: CAPPluginCall) {
        guard let fetchId = call.getString("fetchId"), !fetchId.isEmpty else {
            call.reject("fetchId is required")
            return
        }
        guard let urlValue = call.getString("url"), let url = URL(string: urlValue) else {
            call.reject("url is required")
            return
        }

        let method = (call.getString("method") ?? "GET").uppercased()
        let headers = call.getObject("headers") ?? [:]
        let body = call.getString("body")

        var request = URLRequest(url: url)
        request.httpMethod = method
        for (key, value) in headers {
            if key.caseInsensitiveCompare("origin") == .orderedSame {
                continue
            }
            request.setValue(String(describing: value), forHTTPHeaderField: key)
        }

        if method != "GET" && method != "HEAD" {
            if let body {
                request.httpBody = body.data(using: .utf8)
            } else if requiresRequestBody(method) {
                request.httpBody = Data()
            }
        }

        let configuration = URLSessionConfiguration.ephemeral
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.dataTask(with: request)
        task.taskDescription = fetchId

        activeSessions[fetchId] = session
        activeCalls[fetchId] = call
        activeTasks[fetchId] = task

        task.resume()
    }

    @objc func abort(_ call: CAPPluginCall) {
        guard let fetchId = call.getString("fetchId"), !fetchId.isEmpty else {
            call.reject("fetchId is required")
            return
        }

        let activeCall = activeCalls.removeValue(forKey: fetchId)
        let task = activeTasks.removeValue(forKey: fetchId)
        let session = activeSessions.removeValue(forKey: fetchId)

        activeCall?.reject("Request aborted")
        task?.cancel()
        session?.invalidateAndCancel()
        call.resolve()
    }

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        defer { completionHandler(.allow) }

        guard let fetchId = dataTask.taskDescription,
              let httpResponse = response as? HTTPURLResponse else {
            return
        }

        notifyListeners("httpStream", data: [
            "fetchId": fetchId,
            "event": "response",
            "status": httpResponse.statusCode,
            "statusText": HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode),
            "headers": stringifyHeaders(httpResponse.allHeaderFields),
            "url": httpResponse.url?.absoluteString ?? ""
        ])
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let fetchId = dataTask.taskDescription else {
            return
        }

        notifyListeners("httpStream", data: [
            "fetchId": fetchId,
            "event": "chunk",
            "data": data.base64EncodedString()
        ])
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let fetchId = task.taskDescription else {
            return
        }

        DispatchQueue.main.async {
            let pluginCall = self.activeCalls.removeValue(forKey: fetchId)
            self.activeTasks.removeValue(forKey: fetchId)
            let activeSession = self.activeSessions.removeValue(forKey: fetchId)
            activeSession?.finishTasksAndInvalidate()

            guard let pluginCall else {
                return
            }

            if let error {
                self.notifyListeners("httpStream", data: [
                    "fetchId": fetchId,
                    "event": "error",
                    "error": error.localizedDescription
                ])
                pluginCall.reject(error.localizedDescription)
                return
            }

            self.notifyListeners("httpStream", data: [
                "fetchId": fetchId,
                "event": "done"
            ])
            pluginCall.resolve()
        }
    }

    private func stringifyHeaders(_ headers: [AnyHashable: Any]) -> [String: String] {
        var result: [String: String] = [:]
        for (key, value) in headers {
            result[String(describing: key)] = String(describing: value)
        }
        return result
    }

    private func requiresRequestBody(_ method: String) -> Bool {
        return method == "POST" || method == "PUT" || method == "PATCH"
    }
}
