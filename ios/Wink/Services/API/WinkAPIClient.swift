import CoreGraphics
import Foundation

nonisolated enum WinkAPIError: LocalizedError, Sendable {
    case notConfigured
    case encodingFailed
    case server(status: Int, code: String, message: String)
    case badResponse(status: Int, body: String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "Set the backend URL in Settings."
        case .encodingFailed: "Couldn't encode the image."
        case let .server(status, code, message): "\(message) (\(code), HTTP \(status))"
        case let .badResponse(status, body): "HTTP \(status): \(body.prefix(200))"
        }
    }
}

/// Client for every route in docs/api.md. Stateless and Sendable; build one per endpoint.
nonisolated struct WinkAPIClient: Sendable {
    let endpoint: WinkEndpoint
    var session: URLSession = .shared

    static let maxUploadSide = 1280

    private static let encoder: JSONEncoder = JSONEncoder()
    private static let decoder: JSONDecoder = JSONDecoder()

    static func isoNow() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: Date())
    }

    // MARK: Routes

    func health() async throws -> HealthResponse {
        try await send(request(path: "/v1/health", method: "GET"))
    }

    /// `POST /v1/memories`. `image` must already be cropped to the selection.
    func saveMemory(image: CGImage, meta: SaveMemoryMeta) async throws -> SaveMemoryResponse {
        try await upload(path: "/v1/memories", image: image, meta: meta)
    }

    func glance(image: CGImage, meta: GlanceMeta) async throws -> GlanceResponse {
        try await upload(path: "/v1/glance", image: image, meta: meta)
    }

    func ask(_ body: AskRequest) async throws -> AskResponse {
        try await send(request(path: "/v1/ask", method: "POST", json: body))
    }

    func nearby(_ body: NearbyRequest) async throws -> NearbyResponse {
        try await send(request(path: "/v1/nearby", method: "POST", json: body))
    }

    func memories(limit: Int = 50) async throws -> [Memory] {
        let response: MemoriesResponse = try await send(request(path: "/v1/memories", method: "GET",
                                                                 query: [URLQueryItem(name: "limit", value: String(limit))]))
        return response.memories
    }

    func deleteMemory(id: String) async throws {
        _ = try await sendRaw(request(path: "/v1/memories/\(id)", method: "DELETE"))
    }

    /// `POST /v1/speak` → MP3 of a reply in the backend's voice (Aura-2 or ElevenLabs).
    func speak(_ text: String) async throws -> Data {
        try await sendRaw(request(path: "/v1/speak", method: "POST", json: ["text": text]))
    }

    /// `POST /v1/events` with a `status`, `transcript` or `gesture` event.
    func postEvent(_ event: LiveEvent) async throws {
        _ = try await sendRaw(request(path: "/v1/events", method: "POST", json: event))
    }

    func imageURL(key: String) -> URL {
        endpoint.baseURL.appending(path: "v1/images/\(key)")
    }

    /// `ws(s)://host/v1/live?role=glasses&token=...`
    func liveURL(role: String = "glasses") -> URL? {
        guard var comps = URLComponents(url: endpoint.baseURL.appending(path: "v1/live"), resolvingAgainstBaseURL: false) else { return nil }
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.queryItems = [URLQueryItem(name: "role", value: role), URLQueryItem(name: "token", value: endpoint.token)]
        return comps.url
    }

    // MARK: Plumbing

    private func request(path: String, method: String, query: [URLQueryItem] = []) throws -> URLRequest {
        var comps = URLComponents(url: endpoint.baseURL.appending(path: String(path.dropFirst())), resolvingAgainstBaseURL: false)
        if !query.isEmpty { comps?.queryItems = query }
        guard let url = comps?.url else { throw WinkAPIError.notConfigured }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 30
        req.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return req
    }

    private func request<Body: Encodable>(path: String, method: String, json body: Body) throws -> URLRequest {
        var req = try request(path: path, method: method)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(body)
        return req
    }

    @concurrent private func upload<Meta: Encodable & Sendable, Response: Decodable>(path: String, image: CGImage, meta: Meta) async throws -> Response {
        guard let jpeg = ImageUtils.jpegData(image, maxSide: Self.maxUploadSide) else { throw WinkAPIError.encodingFailed }
        let metaJSON = try Self.encoder.encode(meta)
        let boundary = "wink-\(UUID().uuidString)"
        var body = Data()
        func append(_ s: String) { body.append(Data(s.utf8)) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"meta\"\r\n")
        append("Content-Type: application/json\r\n\r\n")
        body.append(metaJSON)
        append("\r\n--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"image\"; filename=\"frame.jpg\"\r\n")
        append("Content-Type: image/jpeg\r\n\r\n")
        body.append(jpeg)
        append("\r\n--\(boundary)--\r\n")

        var req = try request(path: path, method: "POST")
        req.timeoutInterval = 60
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        return try await send(req)
    }

    private func send<Response: Decodable>(_ req: URLRequest) async throws -> Response {
        let data = try await sendRaw(req)
        do {
            return try Self.decoder.decode(Response.self, from: data)
        } catch {
            throw WinkAPIError.badResponse(status: 200, body: "Decode failed: \(error). Body: \(String(decoding: data, as: UTF8.self))")
        }
    }

    private func sendRaw(_ req: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let envelope = try? Self.decoder.decode(APIErrorEnvelope.self, from: data) {
                throw WinkAPIError.server(status: status, code: envelope.error.code, message: envelope.error.message)
            }
            throw WinkAPIError.badResponse(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return data
    }
}
