// SafeView — ai_client.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: HTTP client for FastAPI /analyze-image and /health (fail-open on error).

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import 'package:safeview/services/settings_service.dart';

/// Backend moderation action per API contract.
enum AnalyzeAction {
  /// No blur — content allowed.
  allow,

  /// Apply full-screen blur / overlay.
  blur,
}

/// JSON body from POST /analyze-image.
class AnalyzeImageResponse {
  /// Creates a parsed analyze-image response.
  const AnalyzeImageResponse({
    required this.category,
    required this.detected,
    required this.confidence,
    required this.action,
    required this.modelLoaded,
  });

  /// Detection category (e.g. nudity).
  final String category;

  /// Whether content exceeded threshold on the server.
  final bool detected;

  /// Model confidence 0.0–1.0.
  final double confidence;

  /// BLUR or ALLOW.
  final AnalyzeAction action;

  /// False when dino weights were missing at server startup.
  final bool modelLoaded;

  /// True when [action] is blur.
  bool get shouldBlur => action == AnalyzeAction.blur;

  /// Parses backend JSON; returns null if shape is invalid.
  static AnalyzeImageResponse? tryParse(Map<String, dynamic> json) {
    final confidence = json['confidence'];
    final detected = json['detected'];
    final actionRaw = json['action'];

    if (confidence is! num || detected is! bool || actionRaw is! String) {
      return null;
    }

    return AnalyzeImageResponse(
      category: json['category'] as String? ?? 'nudity',
      detected: detected,
      confidence: confidence.toDouble(),
      action: _parseAction(actionRaw),
      modelLoaded: json['model_loaded'] as bool? ?? false,
    );
  }

  /// Parses JSON map; throws [FormatException] on invalid shape (internal).
  factory AnalyzeImageResponse.fromJson(Map<String, dynamic> json) {
    final parsed = tryParse(json);
    if (parsed == null) {
      throw const FormatException('Invalid analyze-image response shape');
    }
    return parsed;
  }

  /// Fail-open ALLOW response when backend is offline or errors.
  factory AnalyzeImageResponse.safeDefault(String category) {
    return AnalyzeImageResponse(
      category: category,
      detected: false,
      confidence: 0,
      action: AnalyzeAction.allow,
      modelLoaded: false,
    );
  }

  static AnalyzeAction _parseAction(String raw) {
    return raw.toUpperCase() == 'BLUR' ? AnalyzeAction.blur : AnalyzeAction.allow;
  }

  @override
  String toString() =>
      'AnalyzeImageResponse(category: $category, detected: $detected, '
      'confidence: $confidence, action: $action, modelLoaded: $modelLoaded)';
}

/// Result of [AiClient.analyzeImage] — always returned, never throws.
class AnalyzeImageResult {
  /// Wraps [response] with connectivity metadata.
  const AnalyzeImageResult({
    required this.response,
    required this.backendOnline,
    required this.fromFallback,
  });

  /// Parsed or safe-default body.
  final AnalyzeImageResponse response;

  /// False when the request failed or returned non-200.
  final bool backendOnline;

  /// True when [response] is a client-side safe default.
  final bool fromFallback;
}

/// GET /health JSON shape.
class HealthResponse {
  /// Creates health response.
  const HealthResponse({
    required this.status,
    required this.model,
    required this.modelLoaded,
  });

  /// Server status string (expected "ok").
  final String status;

  /// Model identifier from backend.
  final String model;

  /// Whether weights loaded at startup.
  final bool modelLoaded;

  /// True when status is ok.
  bool get isOk => status == 'ok';

  /// Parses /health JSON; null if invalid.
  static HealthResponse? tryParse(Map<String, dynamic> json) {
    final status = json['status'];
    if (status is! String) return null;
    return HealthResponse(
      status: status,
      model: json['model'] as String? ?? '',
      modelLoaded: json['model_loaded'] as bool? ?? false,
    );
  }
}

/// In-memory backend connectivity snapshot (fail-open UI).
class BackendStatus {
  /// Creates status snapshot.
  const BackendStatus({
    required this.online,
    required this.lastCheckedAt,
    this.lastError,
  });

  /// Whether the last probe succeeded.
  final bool online;

  /// Epoch ms of last check.
  final int lastCheckedAt;

  /// Optional failure message (never frame data).
  final String? lastError;

  /// Initial optimistic state before first request.
  factory BackendStatus.initial() => BackendStatus(
        online: true,
        lastCheckedAt: 0,
      );
}

/// Allowed POST /analyze-image category values.
const List<String> allowedAnalyzeCategories = [
  'nudity',
  'violence',
  'kissing',
  'profanity',
  'lgbtq',
];

/// Default HTTP timeout for analyze and health calls.
const Duration aiClientTimeout = Duration(seconds: 8);

/// Sends JPEG frames to the configured FastAPI backend only.
class AiClient {
  /// Creates a client for [baseUrl] (trailing slash stripped).
  ///
  /// Pass [httpClient] in tests to mock HTTP responses.
  AiClient({
    required String baseUrl,
    http.Client? httpClient,
  })  : _baseUrl = _normalizeBaseUrl(baseUrl),
        _httpClient = httpClient ?? http.Client();

  final String _baseUrl;
  final http.Client _httpClient;

  static BackendStatus _backendStatus = BackendStatus.initial();

  /// Latest connectivity snapshot for dashboard / settings UI.
  static BackendStatus get backendStatus => _backendStatus;

  /// POST /analyze-image. Never throws — returns safe ALLOW on any failure.
  Future<AnalyzeImageResult> analyzeImage({
    required Uint8List jpegBytes,
    required double sensitivity,
    required String category,
  }) async {
    final categoryNormalized = category.trim().toLowerCase();
    final safeDefault = AnalyzeImageResponse.safeDefault(categoryNormalized);

    if (jpegBytes.isEmpty) {
      debugPrint('[SafeView] AiClient: empty JPEG frame, fail-open');
      await _markOffline('Empty frame bytes');
      return AnalyzeImageResult(
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      );
    }

    if (!allowedAnalyzeCategories.contains(categoryNormalized)) {
      debugPrint('[SafeView] AiClient: invalid category $categoryNormalized');
      await _markOffline('Invalid category');
      return AnalyzeImageResult(
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      );
    }

    final clampedSensitivity = sensitivity.clamp(0.0, 1.0);

    try {
      final uri = Uri.parse('$_baseUrl/analyze-image');
      final request = http.MultipartRequest('POST', uri)
        ..fields['sensitivity'] = clampedSensitivity.toString()
        ..fields['category'] = categoryNormalized
        ..files.add(
          http.MultipartFile.fromBytes(
            'frame',
            jpegBytes,
            filename: 'frame.jpg',
            contentType: MediaType('image', 'jpeg'),
          ),
        );

      final streamed = await _httpClient.send(request).timeout(aiClientTimeout);
      final response = await http.Response.fromStream(streamed);

      if (response.statusCode != 200) {
        final message = 'HTTP ${response.statusCode} from analyze-image';
        debugPrint('[SafeView] AiClient: $message');
        await _markOffline(message);
        return AnalyzeImageResult(
          response: safeDefault,
          backendOnline: false,
          fromFallback: true,
        );
      }

      final Map<String, dynamic>? json = _decodeJsonMap(response.body);
      if (json == null) {
        await _markOffline('Invalid JSON from analyze-image');
        return AnalyzeImageResult(
          response: safeDefault,
          backendOnline: false,
          fromFallback: true,
        );
      }

      final parsed = AnalyzeImageResponse.tryParse(json);
      if (parsed == null) {
        await _markOffline('Invalid analyze-image response shape');
        return AnalyzeImageResult(
          response: safeDefault,
          backendOnline: false,
          fromFallback: true,
        );
      }

      await _markOnline();
      return AnalyzeImageResult(
        response: parsed,
        backendOnline: true,
        fromFallback: false,
      );
    } on Exception catch (error, stack) {
      debugPrint('[SafeView] AiClient analyzeImage failed: $error');
      debugPrint(stack.toString());
      await _markOffline(error.toString());
      return AnalyzeImageResult(
        response: safeDefault,
        backendOnline: false,
        fromFallback: true,
      );
    }
  }

  /// GET /health. Returns false on any error; never throws.
  Future<bool> checkHealth({bool updateStatus = true}) async {
    try {
      final uri = Uri.parse('$_baseUrl/health');
      final response = await _httpClient.get(uri).timeout(aiClientTimeout);

      if (response.statusCode != 200) {
        if (updateStatus) {
          await _markOffline('Health check HTTP ${response.statusCode}');
        }
        return false;
      }

      final json = _decodeJsonMap(response.body);
      final health = json == null ? null : HealthResponse.tryParse(json);
      if (health == null || !health.isOk) {
        if (updateStatus) {
          await _markOffline('Health check status not ok');
        }
        return false;
      }

      if (updateStatus) await _markOnline();
      return true;
    } on Exception catch (error) {
      debugPrint('[SafeView] AiClient health check failed: $error');
      if (updateStatus) await _markOffline(error.toString());
      return false;
    }
  }

  /// Convenience: analyze using [SettingsService] URL and effective sensitivity.
  Future<AnalyzeImageResult> analyzeImageWithSettings({
    required Uint8List jpegBytes,
    required SettingsService settings,
    required String category,
  }) {
    return analyzeImage(
      jpegBytes: jpegBytes,
      sensitivity: settings.effectiveThreshold(),
      category: category,
    );
  }

  static String _normalizeBaseUrl(String url) {
    final trimmed = url.trim();
    if (trimmed.isEmpty) return trimmed;
    return trimmed.endsWith('/')
        ? trimmed.substring(0, trimmed.length - 1)
        : trimmed;
  }

  static Map<String, dynamic>? _decodeJsonMap(String body) {
    try {
      final decoded = jsonDecode(body);
      if (decoded is Map<String, dynamic>) return decoded;
      if (decoded is Map) return Map<String, dynamic>.from(decoded);
      return null;
    } on FormatException catch (error) {
      debugPrint('[SafeView] AiClient JSON decode failed: $error');
      return null;
    }
  }

  static Future<void> _markOnline() async {
    _backendStatus = BackendStatus(
      online: true,
      lastCheckedAt: DateTime.now().millisecondsSinceEpoch,
    );
  }

  static Future<void> _markOffline(String message) async {
    _backendStatus = BackendStatus(
      online: false,
      lastCheckedAt: DateTime.now().millisecondsSinceEpoch,
      lastError: message,
    );
  }
}

/// @deprecated Use [AnalyzeImageResponse] — alias for older imports/tests.
typedef AnalyzeResult = AnalyzeImageResponse;
