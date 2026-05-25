// SafeView — browser_screen.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: In-app WebView browser with JS frame bridge, AI analysis, and blur overlay.

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:safeview/constants.dart';
import 'package:safeview/services/ai_client.dart';
import 'package:safeview/services/debug_agent_log.dart';
import 'package:safeview/services/settings_service.dart';
import 'package:safeview/widgets/blur_overlay.dart';
import 'package:safeview/widgets/status_badge.dart';

/// WebView browser: samples `<video>` frames at ≤2 FPS and blurs on detection.
class BrowserScreen extends StatefulWidget {
  /// Creates browser screen.
  const BrowserScreen({super.key});

  @override
  State<BrowserScreen> createState() => _BrowserScreenState();
}

class _BrowserScreenState extends State<BrowserScreen> {
  InAppWebViewController? _webController;
  SettingsService? _settings;
  AiClient? _aiClient;

  bool _isBlurred = false;
  bool _isAnalyzing = false;
  bool _settingsLoading = true;

  final TextEditingController _urlController =
      TextEditingController(text: 'https://www.youtube.com');

  /// Frame-capture bridge injected on [InAppWebView.onLoadStop].
  static String get _frameBridgeScript => '''
(function() {
  var SAMPLE_MS = $sampleIntervalMs;
  var JPEG_QUALITY = $webViewJpegQuality;
  var HANDLER = '$webViewBridgeChannel';

  if (typeof window.__safeViewStopBridge === 'function') {
    window.__safeViewStopBridge();
  }

  var rafId = null;
  var observer = null;

  function postFrame(dataUrl) {
    if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
      window.flutter_inappwebview.callHandler(HANDLER, dataUrl);
    }
  }

  function captureVideo(video) {
    try {
      if (!video || video.readyState < 2) return;
      var w = video.videoWidth || 320;
      var h = video.videoHeight || 240;
      if (w < 1 || h < 1) return;
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, w, h);
      var dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      canvas.width = 0;
      canvas.height = 0;
      postFrame(dataUrl);
    } catch (err) {}
  }

  var lastSample = 0;
  function tick(now) {
    if (now - lastSample >= SAMPLE_MS) {
      lastSample = now;
      document.querySelectorAll('video').forEach(captureVideo);
    }
    rafId = requestAnimationFrame(tick);
  }

  function startObserver() {
    if (!window.MutationObserver) return;
    observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(m) {
        m.addedNodes.forEach(function(node) {
          if (node && node.nodeName === 'VIDEO') {
            captureVideo(node);
          } else if (node && node.querySelectorAll) {
            node.querySelectorAll('video').forEach(captureVideo);
          }
        });
      });
    });
    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  window.__safeViewStopBridge = function() {
    if (rafId != null) cancelAnimationFrame(rafId);
    if (observer) observer.disconnect();
    rafId = null;
    observer = null;
  };

  startObserver();
  rafId = requestAnimationFrame(tick);
})();
''';

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  @override
  void dispose() {
    _urlController.dispose();
    _stopBridgeScript();
    super.dispose();
  }

  Future<void> _loadSettings() async {
    try {
      final settings = await SettingsService.load();
      if (!mounted) return;
      setState(() {
        _settings = settings;
        _aiClient = AiClient(baseUrl: settings.backendUrl);
        _settingsLoading = false;
      });
    } catch (error, stack) {
      SettingsService.logError(error, stack);
      if (mounted) setState(() => _settingsLoading = false);
    }
  }

  Future<void> _stopBridgeScript() async {
    try {
      await _webController?.evaluateJavascript(
        source: 'if (typeof window.__safeViewStopBridge === "function") '
            'window.__safeViewStopBridge();',
      );
    } catch (error) {
      debugPrint('[SafeView] Failed to stop frame bridge: $error');
    }
  }

  Future<void> _injectFrameBridge(InAppWebViewController controller) async {
    try {
      await controller.evaluateJavascript(source: _frameBridgeScript);
    } catch (error) {
      debugPrint('[SafeView] Frame bridge injection failed: $error');
    }
  }

  /// Decodes `data:image/jpeg;base64,...` to JPEG bytes (BR-02: discard after use).
  static Uint8List? decodeJpegDataUrl(String dataUrl) {
    final commaIndex = dataUrl.indexOf(',');
    if (commaIndex < 0) return null;
    try {
      return base64Decode(dataUrl.substring(commaIndex + 1));
    } catch (error) {
      debugPrint('[SafeView] base64 decode failed: $error');
      return null;
    }
  }

  void _setBlurred(bool value) {
    if (!mounted || _isBlurred == value) return;
    setState(() => _isBlurred = value);
  }

  /// Categories to run against the backend (enabled + real model only).
  List<String> _activeCategories(SettingsService settings) {
    return settings.enabledCategoryNames
        .where((name) => activeModelCategories.contains(name))
        .toList();
  }

  Future<void> _onFrameReceived(String dataUrl) async {
    if (!mounted || _settings == null || _aiClient == null) return;
    if (!_settings!.protectionEnabled) {
      _setBlurred(false);
      return;
    }
    if (_isAnalyzing) return;

    final jpegBytes = decodeJpegDataUrl(dataUrl);
    if (jpegBytes == null || jpegBytes.isEmpty) return;

    final categories = _activeCategories(_settings!);
    // #region agent log
    debugAgentLog(
      baseUrl: _settings!.backendUrl,
      hypothesisId: 'H1',
      location: 'browser_screen.dart:_onFrameReceived',
      message: 'frame received for analysis',
      data: {
        'protectionEnabled': _settings!.protectionEnabled,
        'jpegBytes': jpegBytes.length,
        'categories': categories,
      },
    );
    // #endregion
    if (categories.isEmpty) {
      _setBlurred(false);
      return;
    }

    _isAnalyzing = true;
    try {
      var blurRequired = false;

      for (final category in categories) {
        final result = await _aiClient!.analyzeImage(
          jpegBytes: jpegBytes,
          sensitivity: _settings!.sensitivity,
          category: category,
        );

        if (!result.backendOnline || result.fromFallback) {
          _setBlurred(false);
          return;
        }

        // #region agent log
        debugAgentLog(
          baseUrl: _settings!.backendUrl,
          hypothesisId: 'H4',
          location: 'browser_screen.dart:_onFrameReceived:result',
          message: 'analyze-image client result',
          data: {
            'category': category,
            'action': result.response.action.name,
            'detected': result.response.detected,
            'shouldBlur': result.response.shouldBlur,
            'confidence': result.response.confidence,
            'backendOnline': result.backendOnline,
          },
        );
        // #endregion

        if (result.response.shouldBlur || result.response.detected) {
          blurRequired = true;
          break;
        }
      }

      _setBlurred(blurRequired);
      // #region agent log
      debugAgentLog(
        baseUrl: _settings!.backendUrl,
        hypothesisId: 'H4',
        location: 'browser_screen.dart:_onFrameReceived:blurDecision',
        message: 'browser blur decision applied',
        data: {'blurRequired': blurRequired},
      );
      // #endregion
    } catch (error, stack) {
      debugPrint('[SafeView] Browser frame analysis failed: $error');
      debugPrint(stack.toString());
      _setBlurred(false);
    } finally {
      _isAnalyzing = false;
    }
  }

  Future<void> _navigateToUrl() async {
    final raw = _urlController.text.trim();
    if (raw.isEmpty) return;
    final withScheme = raw.contains('://') ? raw : 'https://$raw';
    await _webController?.loadUrl(
      urlRequest: URLRequest(url: WebUri(withScheme)),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_settingsLoading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    final backendOnline = AiClient.backendStatus.online;

    return Scaffold(
      appBar: AppBar(
        title: const Text('SafeView Browser'),
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
        actions: [
          Padding(
            padding: const EdgeInsets.only(right: 12),
            child: Center(
              child: StatusBadge(
                color: backendOnline ? SafeViewColors.active : SafeViewColors.warning,
                pulse: backendOnline && (_settings?.protectionEnabled ?? false),
                label: backendOnline ? 'AI online' : 'AI offline',
              ),
            ),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(8),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _urlController,
                    style: const TextStyle(color: SafeViewColors.text),
                    decoration: const InputDecoration(
                      hintText: 'Enter URL',
                      hintStyle: TextStyle(color: Colors.white54),
                      border: OutlineInputBorder(),
                    ),
                    onSubmitted: (_) => _navigateToUrl(),
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.arrow_forward, color: SafeViewColors.accent),
                  onPressed: _navigateToUrl,
                ),
              ],
            ),
          ),
          Expanded(
            child: BlurOverlay(
              isBlurred: _isBlurred,
              child: InAppWebView(
                initialUrlRequest: URLRequest(
                  url: WebUri(_urlController.text),
                ),
                initialSettings: InAppWebViewSettings(
                  javaScriptEnabled: true,
                  mediaPlaybackRequiresUserGesture: false,
                  allowsInlineMediaPlayback: true,
                ),
                onWebViewCreated: (controller) {
                  _webController = controller;
                  controller.addJavaScriptHandler(
                    handlerName: webViewBridgeChannel,
                    callback: (args) {
                      if (args.isEmpty) return;
                      final payload = args.first;
                      if (payload is String) {
                        _onFrameReceived(payload);
                      }
                    },
                  );
                },
                onLoadStop: (controller, url) async {
                  await _injectFrameBridge(controller);
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}
