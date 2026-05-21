// SafeView — overlay_service_test.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for overlay EventChannel payload parsing.

import 'package:flutter_test/flutter_test.dart';
import 'package:safeview/services/overlay_service.dart';

void main() {
  test('parses detection event map', () {
    final event = OverlayChannelEvent.fromMap({
      'eventType': 'detection',
      'detected': true,
      'category': 'nudity',
      'timestamp': 1_700_000_000_000,
      'fromFallback': false,
    });

    expect(event, isA<OverlayDetectionEvent>());
    final d = event as OverlayDetectionEvent;
    expect(d.detected, isTrue);
    expect(d.category, 'nudity');
    expect(d.timestampMs, 1_700_000_000_000);
  });

  test('parses service status event map', () {
    final event = OverlayChannelEvent.fromMap({
      'eventType': 'service',
      'status': OverlayServiceStatus.capturing,
      'timestamp': 1000,
      'message': 'Screen capture active',
    });

    expect(event, isA<OverlayServiceStatusEvent>());
    final s = event as OverlayServiceStatusEvent;
    expect(s.status, OverlayServiceStatus.capturing);
    expect(s.isCapturing, isTrue);
    expect(s.message, 'Screen capture active');
  });

  test('defaults unknown eventType to detection', () {
    final event = OverlayChannelEvent.fromMap({
      'detected': false,
      'category': 'violence',
    });
    expect(event, isA<OverlayDetectionEvent>());
  });
}
