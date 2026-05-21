// SafeView — widget_test.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Smoke test that SafeViewApp launches dashboard.

import 'package:flutter_test/flutter_test.dart';
import 'package:safeview/app.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  testWidgets('SafeViewApp shows dashboard', (tester) async {
    SharedPreferences.setMockInitialValues({});
    await tester.pumpWidget(const SafeViewApp());
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
    expect(find.text('Protection'), findsOneWidget);
  });
}
