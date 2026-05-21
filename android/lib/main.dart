// SafeView — main.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Application entry point.

import 'package:flutter/material.dart';
import 'package:safeview/app.dart';

/// Starts the SafeView Android client.
void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const SafeViewApp());
}
