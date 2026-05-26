// SafeView — overlay_service.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Flutter MethodChannel / EventChannel bridge to Kotlin OverlayService.

import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:safeview/constants.dart';

/// Event type discriminator from Kotlin [OverlayEventBridge].
abstract class OverlayChannelEvent {
  /// Parses native event map from [com.safeview/status].
  factory OverlayChannelEvent.fromMap(Map<dynamic, dynamic> map) {
    final type = map['eventType'] as String? ?? 'detection';
    if (type == 'service') {
      return OverlayServiceStatusEvent.fromMap(map);
    }
    return OverlayDetectionEvent.fromMap(map);
  }

  /// Epoch ms when the event was emitted.
  int get timestampMs;
}

/// AI detection streamed from screen capture analysis.
class OverlayDetectionEvent implements OverlayChannelEvent {
  /// Creates a detection event.
  const OverlayDetectionEvent({
    required this.detected,
    required this.category,
    required this.timestampMs,
    required this.fromFallback,
  });

  @override
  final int timestampMs;

  /// Whether native layer applied blur overlay.
  final bool detected;

  /// Backend category string.
  final String category;

  /// True when backend was unreachable (fail-open).
  final bool fromFallback;

  /// Parses Kotlin detection payload.
  factory OverlayDetectionEvent.fromMap(Map<dynamic, dynamic> map) {
    return OverlayDetectionEvent(
      detected: map['detected'] as bool? ?? false,
      category: map['category'] as String? ?? 'nudity',
      timestampMs: _readTimestamp(map),
      fromFallback: map['fromFallback'] as bool? ?? false,
    );
  }
}

/// Overlay foreground service lifecycle / overlay window status.
class OverlayServiceStatusEvent implements OverlayChannelEvent {
  /// Creates a service status event.
  const OverlayServiceStatusEvent({
    required this.status,
    required this.timestampMs,
    this.message,
  });

  /// Kotlin [OverlayEventBridge] status value.
  final String status;

  @override
  final int timestampMs;

  /// Optional human-readable detail (never frame data).
  final String? message;

  /// Service is running and capturing.
  bool get isCapturing => status == OverlayServiceStatus.capturing;

  /// Service fully stopped.
  bool get isStopped => status == OverlayServiceStatus.stopped;

  /// Parses Kotlin service payload.
  factory OverlayServiceStatusEvent.fromMap(Map<dynamic, dynamic> map) {
    return OverlayServiceStatusEvent(
      status: map['status'] as String? ?? 'unknown',
      timestampMs: _readTimestamp(map),
      message: map['message'] as String?,
    );
  }
}

/// Known service status strings from Kotlin.
abstract final class OverlayServiceStatus {
  static const String started = 'started';
  static const String capturing = 'capturing';
  static const String stopped = 'stopped';
  static const String error = 'error';
  static const String overlayShown = 'overlay_shown';
  static const String overlayHidden = 'overlay_hidden';
}

int _readTimestamp(Map<dynamic, dynamic> map) {
  final value = map['timestamp'];
  if (value is int) return value;
  if (value is num) return value.toInt();
  return DateTime.now().millisecondsSinceEpoch;
}

/// Flutter bridge: [overlayMethodChannel] + [overlayEventChannel].
class OverlayService {
  /// Creates the native overlay bridge.
  OverlayService();

  static const MethodChannel _methodChannel =
      MethodChannel(overlayMethodChannel);

  static const EventChannel _eventChannel =
      EventChannel(overlayEventChannel);

  Stream<OverlayChannelEvent>? _eventStream;
  StreamSubscription<OverlayChannelEvent>? _broadcastSubscription;
  final StreamController<OverlayChannelEvent> _broadcastController =
      StreamController<OverlayChannelEvent>.broadcast();

  /// All native events (detection + service status).
  Stream<OverlayChannelEvent> get events {
    _ensureListening();
    return _broadcastController.stream;
  }

  /// Detection-only events for the status feed.
  Stream<OverlayDetectionEvent> get detectionEvents => events
      .where((e) => e is OverlayDetectionEvent)
      .cast<OverlayDetectionEvent>();

  /// Service lifecycle events.
  Stream<OverlayServiceStatusEvent> get serviceStatusEvents => events
      .where((e) => e is OverlayServiceStatusEvent)
      .cast<OverlayServiceStatusEvent>();

  void _ensureListening() {
    if (_broadcastSubscription != null) return;

    _eventStream ??= _eventChannel.receiveBroadcastStream().map((dynamic raw) {
      if (raw is Map) {
        return OverlayChannelEvent.fromMap(raw);
      }
      debugPrint('[SafeView] OverlayService: unexpected event type $raw');
      return OverlayServiceStatusEvent(
        status: OverlayServiceStatus.error,
        timestampMs: DateTime.now().millisecondsSinceEpoch,
        message: 'Unexpected event payload',
      );
    });

    _broadcastSubscription = _eventStream!.listen(
      _broadcastController.add,
      onError: (Object error) {
        debugPrint('[SafeView] Overlay EventChannel error: $error');
        _broadcastController.add(
          OverlayServiceStatusEvent(
            status: OverlayServiceStatus.error,
            timestampMs: DateTime.now().millisecondsSinceEpoch,
            message: error.toString(),
          ),
        );
      },
    );
  }

  /// Whether the app can draw over other apps (required for overlay mode).
  Future<bool> canDrawOverlays() async {
    try {
      final result = await _methodChannel.invokeMethod<bool>('canDrawOverlays');
      return result ?? false;
    } catch (error) {
      debugPrint('[SafeView] canDrawOverlays failed: $error');
      return false;
    }
  }

  /// Opens system settings for display-over-other-apps permission.
  Future<void> openOverlaySettings() async {
    try {
      await _methodChannel.invokeMethod<void>('openOverlaySettings');
    } catch (error, stack) {
      debugPrint('[SafeView] openOverlaySettings failed: $error');
      debugPrint(stack.toString());
    }
  }

  /// Starts MediaProjection capture via Kotlin [OverlayService].
  ///
  /// Returns true when the user granted screen capture and the service started.
  Future<bool> startCapture({
    required double sensitivity,
    required List<String> categories,
    required String backendUrl,
    String audioLanguage = 'en',
    List<String> profanityWords = const [],
  }) async {
    try {
      final result = await _methodChannel.invokeMethod<bool>(
        'startCapture',
        <String, dynamic>{
          'sensitivity': sensitivity,
          'categories': categories,
          'backendUrl': backendUrl,
          'audioLanguage': audioLanguage,
          'profanityWords': profanityWords,
        },
      );
      return result ?? false;
    } on PlatformException catch (error) {
      debugPrint(
        '[SafeView] startCapture PlatformException: ${error.code} ${error.message}',
      );
      return false;
    } catch (error, stack) {
      debugPrint('[SafeView] OverlayService startCapture failed: $error');
      debugPrint(stack.toString());
      return false;
    }
  }

  /// Stops overlay foreground service and releases MediaProjection.
  Future<void> stopCapture() async {
    try {
      await _methodChannel.invokeMethod<void>('stopCapture');
    } catch (error, stack) {
      debugPrint('[SafeView] OverlayService stopCapture failed: $error');
      debugPrint(stack.toString());
    }
  }

  /// Cancels EventChannel subscription (e.g. when leaving status screen).
  Future<void> dispose() async {
    await _broadcastSubscription?.cancel();
    _broadcastSubscription = null;
  }
}
