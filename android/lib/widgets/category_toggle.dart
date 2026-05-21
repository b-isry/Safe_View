// SafeView — category_toggle.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Reusable per-category filter switch for settings screen.

import 'package:flutter/material.dart';
import 'package:safeview/constants.dart';

/// Labeled switch for enabling a content filter category.
class CategoryToggle extends StatelessWidget {
  /// Creates toggle for [title] bound to [value].
  const CategoryToggle({
    super.key,
    required this.title,
    required this.value,
    required this.onChanged,
  });

  /// Display name, e.g. "Nudity".
  final String title;

  /// Current enabled state.
  final bool value;

  /// Called when user toggles.
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return SwitchListTile(
      title: Text(
        title,
        style: const TextStyle(color: SafeViewColors.text),
      ),
      value: value,
      activeThumbColor: SafeViewColors.accent,
      onChanged: onChanged,
    );
  }
}
