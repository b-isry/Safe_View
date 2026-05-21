// SafeView — constants.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Shared magic numbers and brand colors for the Android client.

import 'package:flutter/material.dart';

/// Blur sigma for WebView [BackdropFilter] overlay (matches extension 24px blur).
const double blurSigma = 24.0;

/// Fade in/out duration for [BlurOverlay] (matches extension 0.15s filter transition).
const int blurTransitionMs = 150;

/// Minimum interval between frame samples (≤ 2 FPS per BR spec).
const int sampleIntervalMs = 500;

/// Profanity audio mute duration (BR-05).
const int muteDurationMs = 1500;

/// BR-01 confidence floor regardless of user sensitivity.
const double confidenceFloor = 0.75;

/// Default backend URL for Android emulator loopback.
const String defaultBackendUrlEmulator = 'http://10.0.2.2:8000';

/// Default backend URL placeholder for physical devices (user configures in settings).
const String defaultBackendUrlDevice = 'http://192.168.1.100:8000';

/// MethodChannel name for overlay / MediaProjection control.
const String overlayMethodChannel = 'com.safeview/overlay';

/// EventChannel name for overlay status and detection events.
const String overlayEventChannel = 'com.safeview/status';

/// JavaScript bridge channel name injected into WebView.
const String webViewBridgeChannel = 'SafeViewBridge';

/// Categories with real inference (stubs skipped to limit requests per frame).
const List<String> activeModelCategories = ['nudity'];

/// JPEG quality for WebView canvas.toDataURL (0.0–1.0).
const double webViewJpegQuality = 0.7;

/// SafeView brand palette.
abstract final class SafeViewColors {
  static const Color background = Color(0xFF0D1B2A);
  static const Color accent = Color(0xFF00B4D8);
  static const Color text = Color(0xFFFFFFFF);
  static const Color warning = Color(0xFFFF6B6B);
  static const Color active = Color(0xFF2ECC71);
}
