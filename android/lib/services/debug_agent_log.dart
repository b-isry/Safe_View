// SafeView — debug_agent_log.dart
// Purpose: Relay Android debug logs to backend NDJSON ingest (debug session only).

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

/// Fire-and-forget debug log relay via FastAPI /internal/debug-ingest.
void debugAgentLog({
  required String baseUrl,
  required String hypothesisId,
  required String location,
  required String message,
  Map<String, dynamic>? data,
}) {
  final normalized = baseUrl.trim().replaceAll(RegExp(r'/+$'), '');
  if (normalized.isEmpty) return;

  final uri = Uri.parse('$normalized/internal/debug-ingest');
  final body = jsonEncode({
    'hypothesisId': hypothesisId,
    'location': location,
    'message': message,
    'data': data ?? <String, dynamic>{},
  });

  http
      .post(
        uri,
        headers: const {'Content-Type': 'application/json'},
        body: body,
      )
      .timeout(const Duration(seconds: 2))
      .then((_) {}, onError: (Object error) {
        debugPrint('[SafeView][debug] ingest failed: $error');
      });
}
