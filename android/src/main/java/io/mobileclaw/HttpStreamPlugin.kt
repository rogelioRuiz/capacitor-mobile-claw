package io.mobileclaw

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "HttpStream")
class HttpStreamPlugin : Plugin() {
    private data class ActiveRequest(
        val pluginCall: PluginCall,
        val httpCall: Call,
    )

    private val client = OkHttpClient()
    private val activeRequests = ConcurrentHashMap<String, ActiveRequest>()

    @PluginMethod
    fun stream(call: PluginCall) {
        val fetchId = call.getString("fetchId") ?: return call.reject("fetchId is required")
        val url = call.getString("url") ?: return call.reject("url is required")
        val method = (call.getString("method") ?: "GET").uppercase()
        val headers = call.getObject("headers") ?: JSObject()
        val body = call.getString("body")

        val requestBuilder = Request.Builder().url(url)
        val headerKeys = headers.keys()
        while (headerKeys.hasNext()) {
            val name = headerKeys.next()
            if (name.equals("origin", ignoreCase = true)) {
                continue
            }
            val value = headers.optString(name)
            if (value.isNotEmpty()) {
                requestBuilder.addHeader(name, value)
            }
        }

        val mediaType = headerValue(headers, "content-type")?.toMediaTypeOrNull()
        val requestBody = when {
            method == "GET" || method == "HEAD" -> null
            body != null -> body.toRequestBody(mediaType)
            requiresRequestBody(method) -> ByteArray(0).toRequestBody(null)
            else -> null
        }
        requestBuilder.method(method, requestBody)

        val httpCall = client.newCall(requestBuilder.build())
        activeRequests[fetchId] = ActiveRequest(call, httpCall)

        httpCall.enqueue(object : Callback {
            override fun onFailure(callRef: Call, e: IOException) {
                val active = activeRequests.remove(fetchId) ?: return
                notifyError(fetchId, e.message ?: "HTTP request failed")
                active.pluginCall.reject(e.message ?: "HTTP request failed", e)
            }

            override fun onResponse(callRef: Call, response: Response) {
                try {
                    response.use { httpResponse ->
                        if (!activeRequests.containsKey(fetchId)) {
                            return
                        }

                        val responseHeaders = JSObject()
                        for (name in httpResponse.headers.names()) {
                            responseHeaders.put(name, httpResponse.header(name))
                        }

                        val responseEvent = JSObject()
                        responseEvent.put("fetchId", fetchId)
                        responseEvent.put("event", "response")
                        responseEvent.put("status", httpResponse.code)
                        responseEvent.put("statusText", httpResponse.message)
                        responseEvent.put("headers", responseHeaders)
                        responseEvent.put("url", httpResponse.request.url.toString())
                        notifyListeners("httpStream", responseEvent)

                        httpResponse.body?.byteStream()?.use { stream ->
                            val buffer = ByteArray(4096)
                            while (true) {
                                val bytesRead = stream.read(buffer)
                                if (bytesRead == -1) {
                                    break
                                }

                                val chunkEvent = JSObject()
                                chunkEvent.put("fetchId", fetchId)
                                chunkEvent.put("event", "chunk")
                                chunkEvent.put(
                                    "data",
                                    Base64.encodeToString(buffer, 0, bytesRead, Base64.NO_WRAP),
                                )
                                notifyListeners("httpStream", chunkEvent)
                            }
                        }

                        val active = activeRequests.remove(fetchId) ?: return
                        val doneEvent = JSObject()
                        doneEvent.put("fetchId", fetchId)
                        doneEvent.put("event", "done")
                        notifyListeners("httpStream", doneEvent)
                        active.pluginCall.resolve()
                    }
                } catch (e: Exception) {
                    val active = activeRequests.remove(fetchId) ?: return
                    notifyError(fetchId, e.message ?: "Failed to stream response")
                    active.pluginCall.reject(e.message ?: "Failed to stream response", e)
                }
            }
        })
    }

    @PluginMethod
    fun abort(call: PluginCall) {
        val fetchId = call.getString("fetchId") ?: return call.reject("fetchId is required")
        val active = activeRequests.remove(fetchId)
        if (active != null) {
            active.httpCall.cancel()
            active.pluginCall.reject("Request aborted")
        }
        call.resolve()
    }

    private fun notifyError(fetchId: String, message: String) {
        val event = JSObject()
        event.put("fetchId", fetchId)
        event.put("event", "error")
        event.put("error", message)
        notifyListeners("httpStream", event)
    }

    private fun headerValue(headers: JSObject, target: String): String? {
        val keys = headers.keys()
        while (keys.hasNext()) {
            val name = keys.next()
            if (name.equals(target, ignoreCase = true)) {
                return headers.optString(name).ifEmpty { null }
            }
        }
        return null
    }

    private fun requiresRequestBody(method: String): Boolean {
        return method == "POST" || method == "PUT" || method == "PATCH"
    }
}
