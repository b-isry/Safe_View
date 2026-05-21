// SafeView — permissions_service.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Query Android permissions and deep-link to system settings screens.

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:safeview/constants.dart';

/// Snapshot of required Android permissions for SafeView overlay mode.
class PermissionStatusSnapshot {
  /// Creates permission status from native map.
  const PermissionStatusSnapshot({
    required this.overlayGranted,
    required this.notificationsGranted,
    required this.internetGranted,
  });

  /// Display over other apps (SYSTEM_ALERT_WINDOW).
  final bool overlayGranted;

  /// POST_NOTIFICATIONS (Android 13+).
  final bool notificationsGranted;

  /// INTERNET (declared in manifest).
  final bool internetGranted;

  /// All permissions required for overlay capture mode.
  bool get overlayModeReady => overlayGranted && notificationsGranted;

  /// Parses MethodChannel map from Kotlin.
  factory PermissionStatusSnapshot.fromMap(Map<dynamic, dynamic> map) {
    return PermissionStatusSnapshot(
      overlayGranted: map['overlay'] as bool? ?? false,
      notificationsGranted: map['notifications'] as bool? ?? true,
      internetGranted: map['internet'] as bool? ?? true,
    );
  }
}

/// Native permission queries via [overlayMethodChannel].
class PermissionsService {
  static const MethodChannel _channel = MethodChannel(overlayMethodChannel);

  /// Reads overlay, notification, and internet permission state.
  Future<PermissionStatusSnapshot> getStatus() async {
    try {
      final raw = await _channel.invokeMethod<Map<dynamic, dynamic>>(
        'getPermissionStatus',
      );
      if (raw == null) {
        return const PermissionStatusSnapshot(
          overlayGranted: false,
          notificationsGranted: false,
          internetGranted: true,
        );
      }
      return PermissionStatusSnapshot.fromMap(raw);
    } catch (error) {
      debugPrint('[SafeView] getPermissionStatus failed: $error');
      return const PermissionStatusSnapshot(
        overlayGranted: false,
        notificationsGranted: false,
        internetGranted: true,
      );
    }
  }

  /// Opens display-over-other-apps settings for this package.
  Future<void> openOverlaySettings() async {
    try {
      await _channel.invokeMethod<void>('openOverlaySettings');
    } catch (error) {
      debugPrint('[SafeView] openOverlaySettings failed: $error');
    }
  }

  /// Opens the app details page in Android settings.
  Future<void> openAppSettings() async {
    try {
      await _channel.invokeMethod<void>('openAppSettings');
    } catch (error) {
      debugPrint('[SafeView] openAppSettings failed: $error');
    }
  }

  /// Opens notification settings for this app.
  Future<void> openNotificationSettings() async {
    try {
      await _channel.invokeMethod<void>('openNotificationSettings');
    } catch (error) {
      debugPrint('[SafeView] openNotificationSettings failed: $error');
    }
  }
}
