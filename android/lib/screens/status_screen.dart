// SafeView — status_screen.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Scrolling log of detections (category + timestamp only, no pixels).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:safeview/constants.dart';
import 'package:safeview/services/overlay_service.dart';

/// Single log entry for status feed.
class StatusLogEntry {
  /// Creates a log line.
  StatusLogEntry({
    required this.label,
    required this.timestamp,
    required this.detected,
  });

  /// Display label (category or service status).
  final String label;

  /// When the event occurred.
  final DateTime timestamp;

  /// Whether blur was applied (detection events only).
  final bool detected;
}

/// Live status feed from [OverlayService] EventChannel.
class StatusScreen extends StatefulWidget {
  /// Creates status screen.
  const StatusScreen({super.key});

  @override
  State<StatusScreen> createState() => _StatusScreenState();
}

class _StatusScreenState extends State<StatusScreen> {
  final OverlayService _overlayService = OverlayService();
  final List<StatusLogEntry> _entries = [];
  StreamSubscription<OverlayChannelEvent>? _subscription;

  @override
  void initState() {
    super.initState();
    _subscription = _overlayService.events.listen(_onEvent);
  }

  void _onEvent(OverlayChannelEvent event) {
    if (!mounted) return;

    if (event is OverlayDetectionEvent) {
      setState(() {
        _entries.insert(
          0,
          StatusLogEntry(
            label: event.category,
            timestamp: DateTime.fromMillisecondsSinceEpoch(event.timestampMs),
            detected: event.detected,
          ),
        );
        if (_entries.length > 100) _entries.removeLast();
      });
      return;
    }

    if (event is OverlayServiceStatusEvent) {
      setState(() {
        _entries.insert(
          0,
          StatusLogEntry(
            label: 'Service: ${event.status}',
            timestamp: DateTime.fromMillisecondsSinceEpoch(event.timestampMs),
            detected: false,
          ),
        );
        if (_entries.length > 100) _entries.removeLast();
      });
    }
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _overlayService.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Status')),
      body: _entries.isEmpty
          ? const Center(
              child: Text(
                'No events yet.\nStart overlay capture from the dashboard.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Colors.white54),
              ),
            )
          : ListView.builder(
              itemCount: _entries.length,
              itemBuilder: (context, index) {
                final e = _entries[index];
                return ListTile(
                  leading: Icon(
                    e.detected ? Icons.shield : Icons.info_outline,
                    color: e.detected ? SafeViewColors.warning : SafeViewColors.accent,
                  ),
                  title: Text(
                    e.label,
                    style: const TextStyle(color: SafeViewColors.text),
                  ),
                  subtitle: Text(
                    e.timestamp.toIso8601String(),
                    style: const TextStyle(color: Colors.white54),
                  ),
                );
              },
            ),
    );
  }
}
