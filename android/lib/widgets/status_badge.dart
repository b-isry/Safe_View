// SafeView — status_badge.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Colored status dot with optional pulse for active monitoring.

import 'package:flutter/material.dart';
import 'package:safeview/constants.dart';

/// Monitoring / offline / idle indicator for dashboard and browser.
class StatusBadge extends StatefulWidget {
  /// Creates badge with [color] and optional [pulse].
  const StatusBadge({
    super.key,
    required this.color,
    this.pulse = false,
    this.label,
  });

  /// Dot color (green active, red offline, grey idle).
  final Color color;

  /// Animate pulse when monitoring is active.
  final bool pulse;

  /// Optional text beside dot.
  final String? label;

  @override
  State<StatusBadge> createState() => _StatusBadgeState();
}

class _StatusBadgeState extends State<StatusBadge>
    with SingleTickerProviderStateMixin {
  late AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    );
    if (widget.pulse) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void didUpdateWidget(StatusBadge oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.pulse && !_controller.isAnimating) {
      _controller.repeat(reverse: true);
    } else if (!widget.pulse) {
      _controller.stop();
      _controller.value = 1.0;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        AnimatedBuilder(
          animation: _controller,
          builder: (context, child) {
            final scale = widget.pulse ? 0.85 + (_controller.value * 0.3) : 1.0;
            return Transform.scale(
              scale: scale,
              child: child,
            );
          },
          child: Container(
            width: 12,
            height: 12,
            decoration: BoxDecoration(
              color: widget.color,
              shape: BoxShape.circle,
              boxShadow: widget.pulse
                  ? [
                      BoxShadow(
                        color: widget.color.withValues(alpha: 0.5),
                        blurRadius: 8,
                        spreadRadius: 2,
                      ),
                    ]
                  : null,
            ),
          ),
        ),
        if (widget.label != null) ...[
          const SizedBox(width: 8),
          Text(
            widget.label!,
            style: const TextStyle(color: SafeViewColors.text, fontSize: 14),
          ),
        ],
      ],
    );
  }
}
