// SafeView — dashboard_screen.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Home screen — mode toggle, protection switch, live EventChannel feed.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:safeview/constants.dart';
import 'package:safeview/services/ai_client.dart';
import 'package:safeview/services/overlay_service.dart';
import 'package:safeview/services/settings_service.dart';
import 'package:safeview/widgets/status_badge.dart';
import 'package:safeview/widgets/status_feed_tile.dart';

/// Dashboard log line from EventChannel or local UI.
class DashboardFeedEntry {
  /// Creates a feed entry.
  DashboardFeedEntry({
    required this.label,
    required this.timestamp,
    required this.isDetection,
    this.detected = false,
  });

  /// Display text (category or service status).
  final String label;

  /// Event time.
  final DateTime timestamp;

  /// AI detection vs service status row.
  final bool isDetection;

  /// Blur triggered (detections only).
  final bool detected;
}

/// Main dashboard with browser vs overlay mode and live status feed.
class DashboardScreen extends StatefulWidget {
  /// Creates dashboard.
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  static const int _maxFeedEntries = 80;

  final OverlayService _overlayService = OverlayService();
  SettingsService? _settings;
  StreamSubscription<OverlayChannelEvent>? _eventSubscription;

  bool _loading = true;
  bool _overlayCapturing = false;
  bool _backendOnline = false;
  final List<DashboardFeedEntry> _feedEntries = [];

  @override
  void initState() {
    super.initState();
    _bootstrap();
  }

  Future<void> _bootstrap() async {
    await _loadSettings();
    _subscribeToEvents();
  }

  Future<void> _loadSettings() async {
    try {
      final settings = await SettingsService.load();
      final client = AiClient(baseUrl: settings.backendUrl);
      final online = await client.checkHealth();
      if (mounted) {
        setState(() {
          _settings = settings;
          _backendOnline = online;
          _loading = false;
        });
      }
    } catch (error, stack) {
      SettingsService.logError(error, stack);
      if (mounted) setState(() => _loading = false);
    }
  }

  void _subscribeToEvents() {
    _eventSubscription?.cancel();
    _eventSubscription = _overlayService.events.listen(_onChannelEvent);
  }

  void _onChannelEvent(OverlayChannelEvent event) {
    if (!mounted) return;

    if (event is OverlayDetectionEvent) {
      final label = event.detected
          ? '${event.category} — BLUR'
          : '${event.category} — clear';
      _prependFeed(
        DashboardFeedEntry(
          label: label,
          timestamp: DateTime.fromMillisecondsSinceEpoch(event.timestampMs),
          isDetection: true,
          detected: event.detected,
        ),
      );
      if (event.fromFallback) {
        setState(() => _backendOnline = false);
      }
      return;
    }

    if (event is OverlayServiceStatusEvent) {
      if (event.status == OverlayServiceStatus.capturing) {
        setState(() => _overlayCapturing = true);
      } else if (event.status == OverlayServiceStatus.stopped) {
        setState(() => _overlayCapturing = false);
      } else if (event.status == OverlayServiceStatus.error) {
        setState(() => _backendOnline = false);
      }

      final detail = event.message != null ? ': ${event.message}' : '';
      _prependFeed(
        DashboardFeedEntry(
          label: 'Service ${event.status}$detail',
          timestamp: DateTime.fromMillisecondsSinceEpoch(event.timestampMs),
          isDetection: false,
        ),
      );
    }
  }

  void _prependFeed(DashboardFeedEntry entry) {
    setState(() {
      _feedEntries.insert(0, entry);
      if (_feedEntries.length > _maxFeedEntries) {
        _feedEntries.removeLast();
      }
    });
  }

  Future<void> _setProtection(bool value) async {
    await _settings?.setProtectionEnabled(value);
    if (!value && _overlayCapturing) {
      await _overlayService.stopCapture();
      setState(() => _overlayCapturing = false);
    }
    setState(() {});
  }

  Future<void> _setMode(SafeViewMode mode) async {
    if (_overlayCapturing && mode == SafeViewMode.browser) {
      await _overlayService.stopCapture();
      setState(() => _overlayCapturing = false);
    }
    await _settings?.setActiveMode(mode);
    setState(() {});
  }

  Future<void> _toggleOverlayCapture(
    SettingsService settings,
    bool protectionOn,
  ) async {
    if (_overlayCapturing) {
      await _overlayService.stopCapture();
      setState(() => _overlayCapturing = false);
      return;
    }

    if (!protectionOn) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Turn on Protection first.')),
      );
      return;
    }

    final canOverlay = await _overlayService.canDrawOverlays();
    if (!canOverlay) {
      await _overlayService.openOverlaySettings();
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content: Text(
            'Grant "Display over other apps", then tap Start Overlay again.',
          ),
        ),
      );
      return;
    }

    final started = await _overlayService.startCapture(
      sensitivity: settings.sensitivity,
      categories: settings.enabledCategoryNames,
      backendUrl: settings.backendUrl,
    );
    if (!mounted) return;
    setState(() => _overlayCapturing = started);
    if (!started) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Screen capture was not started.')),
      );
    }
  }

  Future<void> _openSettings() async {
    await Navigator.pushNamed(context, '/settings');
    await _loadSettings();
  }

  @override
  void dispose() {
    _eventSubscription?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(
        body: Center(child: CircularProgressIndicator()),
      );
    }

    final settings = _settings!;
    final protectionOn = settings.protectionEnabled;
    final overlayMode = settings.activeMode == SafeViewMode.overlay;
    final filterCount = settings.enabledFilterCount;

    return Scaffold(
      appBar: AppBar(
        title: const Text('SafeView'),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            onPressed: _openSettings,
          ),
        ],
      ),
      body: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              spacing: 12,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                StatusBadge(
                  color: protectionOn ? SafeViewColors.active : SafeViewColors.warning,
                  pulse: protectionOn,
                  label: protectionOn ? 'Protection ON' : 'Protection OFF',
                ),
                StatusBadge(
                  color: _backendOnline ? SafeViewColors.active : SafeViewColors.warning,
                  label: _backendOnline ? 'AI online' : 'AI offline',
                ),
                Chip(
                  label: Text(
                    overlayMode ? 'Overlay mode' : 'Browser mode',
                    style: const TextStyle(color: SafeViewColors.text),
                  ),
                  backgroundColor: SafeViewColors.background,
                  side: const BorderSide(color: SafeViewColors.accent),
                ),
                Text(
                  '$filterCount filters active',
                  style: const TextStyle(color: Colors.white54, fontSize: 13),
                ),
              ],
            ),
            const SizedBox(height: 16),
            SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: const Text(
                'Protection',
                style: TextStyle(color: SafeViewColors.text),
              ),
              value: protectionOn,
              activeThumbColor: SafeViewColors.accent,
              onChanged: _setProtection,
            ),
            const Text(
              'Active mode',
              style: TextStyle(color: SafeViewColors.text, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
            SegmentedButton<SafeViewMode>(
              segments: const [
                ButtonSegment(
                  value: SafeViewMode.browser,
                  label: Text('Browser'),
                  icon: Icon(Icons.public),
                ),
                ButtonSegment(
                  value: SafeViewMode.overlay,
                  label: Text('Overlay'),
                  icon: Icon(Icons.layers),
                ),
              ],
              selected: {settings.activeMode},
              onSelectionChanged: (set) => _setMode(set.first),
            ),
            const SizedBox(height: 12),
            FilledButton.icon(
              onPressed: protectionOn
                  ? () async {
                      if (overlayMode) {
                        await _toggleOverlayCapture(settings, protectionOn);
                      } else {
                        Navigator.pushNamed(context, '/browser');
                      }
                    }
                  : null,
              icon: Icon(overlayMode ? Icons.layers : Icons.public),
              label: Text(
                overlayMode
                    ? (_overlayCapturing ? 'Stop Overlay' : 'Start Overlay')
                    : 'Open Browser',
              ),
            ),
            const SizedBox(height: 16),
            const Text(
              'Live status',
              style: TextStyle(
                color: SafeViewColors.accent,
                fontSize: 16,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 4),
            Expanded(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: SafeViewColors.background.withValues(alpha: 0.6),
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: SafeViewColors.accent.withValues(alpha: 0.4)),
                ),
                child: _feedEntries.isEmpty
                    ? const Center(
                        child: Text(
                          'Events appear here when overlay capture runs\n'
                          'or you open the in-app browser.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Colors.white54, fontSize: 13),
                        ),
                      )
                    : ListView.builder(
                        itemCount: _feedEntries.length,
                        itemBuilder: (context, index) {
                          final e = _feedEntries[index];
                          return StatusFeedTile(
                            label: e.label,
                            timestamp: e.timestamp,
                            isDetection: e.isDetection,
                            detected: e.detected,
                          );
                        },
                      ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
