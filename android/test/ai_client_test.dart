// SafeView — ai_client_test.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for AiClient mock HTTP and response parsing.

import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:safeview/services/ai_client.dart';

const String _mockBaseUrl = 'http://10.0.2.2:8000';

/// Minimal JPEG SOI marker bytes for multipart upload tests.
final Uint8List _fakeJpeg = Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xD9]);

http.Client _mockBackendClient() {
  return MockClient((http.Request request) async {
    final path = request.url.path;

    if (path.endsWith('/health')) {
      expect(request.method, 'GET');
      return http.Response(
        jsonEncode({
          'status': 'ok',
          'model': 'dino_v3_linear',
          'model_loaded': true,
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    }

    if (path.endsWith('/analyze-image')) {
      expect(request.method, 'POST');
      return http.Response(
        jsonEncode({
          'category': 'nudity',
          'detected': true,
          'confidence': 0.87,
          'action': 'BLUR',
          'model_loaded': true,
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    }

    return http.Response('not found', 404);
  });
}

void main() {
  setUp(() {
    AiClient(baseUrl: _mockBaseUrl);
  });

  group('AnalyzeImageResponse parsing', () {
    test('fromJson parses backend contract shape', () {
      final result = AnalyzeImageResponse.fromJson({
        'category': 'nudity',
        'detected': true,
        'confidence': 0.87,
        'action': 'BLUR',
        'model_loaded': true,
      });

      expect(result.category, 'nudity');
      expect(result.detected, isTrue);
      expect(result.confidence, closeTo(0.87, 0.001));
      expect(result.action, AnalyzeAction.blur);
      expect(result.shouldBlur, isTrue);
      expect(result.modelLoaded, isTrue);
    });

    test('tryParse returns null for invalid shape', () {
      expect(
        AnalyzeImageResponse.tryParse({'detected': 'yes'}),
        isNull,
      );
    });

    test('safeDefault is fail-open ALLOW', () {
      final d = AnalyzeImageResponse.safeDefault('violence');
      expect(d.detected, isFalse);
      expect(d.action, AnalyzeAction.allow);
      expect(d.confidence, 0);
      expect(d.modelLoaded, isFalse);
    });
  });

  group('AiClient mock HTTP', () {
    test('checkHealth returns true on mocked ok response', () async {
      final client = AiClient(
        baseUrl: _mockBaseUrl,
        httpClient: _mockBackendClient(),
      );

      final ok = await client.checkHealth(updateStatus: false);
      expect(ok, isTrue);
    });

    test('analyzeImage parses mocked BLUR response', () async {
      final client = AiClient(
        baseUrl: _mockBaseUrl,
        httpClient: _mockBackendClient(),
      );

      final result = await client.analyzeImage(
        jpegBytes: _fakeJpeg,
        sensitivity: 0.75,
        category: 'nudity',
      );

      expect(result.backendOnline, isTrue);
      expect(result.fromFallback, isFalse);
      expect(result.response.category, 'nudity');
      expect(result.response.detected, isTrue);
      expect(result.response.confidence, closeTo(0.87, 0.001));
      expect(result.response.action, AnalyzeAction.blur);
      expect(result.response.shouldBlur, isTrue);
      expect(result.response.modelLoaded, isTrue);
    });

    test('analyzeImage sends multipart POST to /analyze-image', () async {
      http.Request? captured;

      final mock = MockClient((http.Request request) async {
        captured = request;
        return http.Response(
          jsonEncode({
            'category': 'nudity',
            'detected': false,
            'confidence': 0.2,
            'action': 'ALLOW',
            'model_loaded': true,
          }),
          200,
          headers: {'content-type': 'application/json'},
        );
      });

      final client = AiClient(
        baseUrl: _mockBaseUrl,
        httpClient: mock,
      );

      await client.analyzeImage(
        jpegBytes: _fakeJpeg,
        sensitivity: 0.75,
        category: 'nudity',
      );

      expect(captured, isNotNull);
      expect(captured!.method, 'POST');
      expect(captured!.url.path, '/analyze-image');
    });

    test('analyzeImage fail-open on HTTP 500', () async {
      final mock = MockClient((_) async => http.Response('error', 500));
      final client = AiClient(
        baseUrl: _mockBaseUrl,
        httpClient: mock,
      );

      final result = await client.analyzeImage(
        jpegBytes: _fakeJpeg,
        sensitivity: 0.75,
        category: 'nudity',
      );

      expect(result.fromFallback, isTrue);
      expect(result.backendOnline, isFalse);
      expect(result.response.action, AnalyzeAction.allow);
    });

    test('analyzeImage fail-open on empty frame without throwing', () async {
      final client = AiClient(
        baseUrl: _mockBaseUrl,
        httpClient: _mockBackendClient(),
      );

      final result = await client.analyzeImage(
        jpegBytes: Uint8List(0),
        sensitivity: 0.75,
        category: 'nudity',
      );

      expect(result.fromFallback, isTrue);
      expect(result.response.detected, isFalse);
    });
  });

  group('HealthResponse parsing', () {
    test('tryParse accepts ok status', () {
      final h = HealthResponse.tryParse({
        'status': 'ok',
        'model': 'dino_v3_linear',
        'model_loaded': true,
      });
      expect(h?.isOk, isTrue);
      expect(h?.modelLoaded, isTrue);
    });
  });
}
