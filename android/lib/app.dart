// SafeView — app.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: MaterialApp root, theme, and navigation routes.

import 'package:flutter/material.dart';
import 'package:safeview/constants.dart';
import 'package:safeview/screens/browser_screen.dart';
import 'package:safeview/screens/dashboard_screen.dart';
import 'package:safeview/screens/settings_screen.dart';
import 'package:safeview/screens/status_screen.dart';

/// Root widget with SafeView branding and named routes.
class SafeViewApp extends StatelessWidget {
  /// Creates the app shell.
  const SafeViewApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SafeView',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: SafeViewColors.background,
        colorScheme: const ColorScheme.dark(
          primary: SafeViewColors.accent,
          surface: SafeViewColors.background,
          onSurface: SafeViewColors.text,
          error: SafeViewColors.warning,
        ),
        appBarTheme: const AppBarTheme(
          backgroundColor: SafeViewColors.background,
          foregroundColor: SafeViewColors.text,
        ),
      ),
      initialRoute: '/',
      routes: {
        '/': (context) => const DashboardScreen(),
        '/browser': (context) => const BrowserScreen(),
        '/settings': (context) => const SettingsScreen(),
        '/status': (context) => const StatusScreen(),
      },
    );
  }
}
