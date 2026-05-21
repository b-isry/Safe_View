// SafeView — blur_overlay.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Full-screen BackdropFilter blur over WebView when content is detected.

import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:safeview/constants.dart';

/// Stacks [child] under a full-screen [BackdropFilter] blur toggled by [isBlurred].
///
/// The blur layer fades in/out over [blurTransitionMs] (BR-07: always above content).
class BlurOverlay extends StatelessWidget {
  /// Creates overlay; set [isBlurred] true to show the animated blur layer.
  const BlurOverlay({
    super.key,
    required this.child,
    required this.isBlurred,
  });

  /// Content under the blur (typically [InAppWebView]).
  final Widget child;

  /// When true, blur layer animates to full opacity; when false, animates out.
  final bool isBlurred;

  static final ImageFilter _blurFilter = ImageFilter.blur(
    sigmaX: blurSigma,
    sigmaY: blurSigma,
  );

  static final Duration _transitionDuration =
      Duration(milliseconds: blurTransitionMs);

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        child,
        IgnorePointer(
          key: const Key('safeview_blur_layer'),
          ignoring: !isBlurred,
          child: AnimatedOpacity(
            opacity: isBlurred ? 1.0 : 0.0,
            duration: _transitionDuration,
            curve: Curves.easeInOut,
            child: ClipRect(
              child: BackdropFilter(
                filter: _blurFilter,
                child: Container(
                  color: SafeViewColors.background.withValues(alpha: 0.2),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
