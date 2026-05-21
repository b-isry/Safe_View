// SafeView — status_feed_tile.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Single row in the dashboard live status feed (no pixel data).

import 'package:flutter/material.dart';
import 'package:safeview/constants.dart';

/// One line in the live status feed (category or service status + time).
class StatusFeedTile extends StatelessWidget {
  /// Creates a feed row.
  const StatusFeedTile({
    super.key,
    required this.label,
    required this.timestamp,
    required this.isDetection,
    this.detected = false,
  });

  /// Category name or service status label.
  final String label;

  /// When the event occurred.
  final DateTime timestamp;

  /// True for AI detection rows; false for service lifecycle rows.
  final bool isDetection;

  /// Whether blur was triggered (detection rows only).
  final bool detected;

  @override
  Widget build(BuildContext context) {
    final time =
        '${timestamp.hour.toString().padLeft(2, '0')}:'
        '${timestamp.minute.toString().padLeft(2, '0')}:'
        '${timestamp.second.toString().padLeft(2, '0')}';

    IconData icon;
    Color color;
    if (!isDetection) {
      icon = Icons.info_outline;
      color = SafeViewColors.accent;
    } else if (detected) {
      icon = Icons.shield;
      color = SafeViewColors.warning;
    } else {
      icon = Icons.shield_outlined;
      color = SafeViewColors.active;
    }

    return ListTile(
      dense: true,
      leading: Icon(icon, color: color, size: 20),
      title: Text(
        label,
        style: const TextStyle(color: SafeViewColors.text, fontSize: 14),
      ),
      trailing: Text(
        time,
        style: const TextStyle(color: Colors.white54, fontSize: 12),
      ),
    );
  }
}
