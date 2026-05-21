// SafeView — blur_overlay_test.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Widget tests for BlurOverlay visibility (master prompt §11).

import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:safeview/constants.dart';
import 'package:safeview/widgets/blur_overlay.dart';

void main() {
  group('BlurOverlay widget', () {
    testWidgets('renders BackdropFilter when isBlurred is true', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: BlurOverlay(
            isBlurred: true,
            child: SizedBox(key: Key('child')),
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(const Key('child')), findsOneWidget);
      expect(find.byType(BackdropFilter), findsOneWidget);
      expect(find.byType(Stack), findsOneWidget);

      final backdrop = tester.widget<BackdropFilter>(find.byType(BackdropFilter));
      final filter = backdrop.filter;
      expect(filter, isA<ImageFilter>());
    });

    testWidgets('hides blur layer when isBlurred is false', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: BlurOverlay(
            isBlurred: false,
            child: SizedBox(key: Key('child')),
          ),
        ),
      );
      await tester.pump();

      expect(find.byKey(const Key('child')), findsOneWidget);
      expect(find.byType(BackdropFilter), findsOneWidget);

      final opacity = tester.widget<AnimatedOpacity>(
        find.byType(AnimatedOpacity),
      );
      expect(opacity.opacity, 0.0);
    });

    testWidgets('uses configured transition duration', (tester) async {
      await tester.pumpWidget(
        const MaterialApp(
          home: BlurOverlay(isBlurred: true, child: SizedBox()),
        ),
      );

      final animated = tester.widget<AnimatedOpacity>(
        find.byType(AnimatedOpacity),
      );
      expect(animated.duration, const Duration(milliseconds: blurTransitionMs));
      expect(animated.curve, Curves.easeInOut);
      expect(animated.opacity, 1.0);
    });
  });
}
