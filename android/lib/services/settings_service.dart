// SafeView — settings_service.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Persist user settings via SharedPreferences (BR-04).

import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:safeview/constants.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// SharedPreferences keys for SafeView settings.
abstract final class SettingsKeys {
  static const String protectionEnabled = 'protection_enabled';
  static const String activeMode = 'active_mode';
  static const String backendUrl = 'backend_url';
  static const String sensitivity = 'sensitivity';
  static const String filterNudity = 'filter_nudity';
  static const String filterViolence = 'filter_violence';
  static const String filterKissing = 'filter_kissing';
  static const String filterProfanity = 'filter_profanity';
  static const String filterLgbtq = 'filter_lgbtq';
  static const String profanityWords = 'profanity_words';
}

/// Content filter categories (matches backend / extension).
enum FilterCategory {
  /// Nudity — real model.
  nudity,

  /// Violence stub.
  violence,

  /// Kissing / romantic stub.
  kissing,

  /// Profanity stub.
  profanity,

  /// LGBTQ+ symbols stub.
  lgbtq,
}

/// Active protection mode: in-app browser or system overlay.
enum SafeViewMode {
  /// WebView in-app browser.
  browser,

  /// MediaProjection + WindowManager overlay.
  overlay,
}

/// Sensitivity slider stops (options / settings UI).
enum SensitivityPreset {
  /// 0.60
  low,

  /// 0.75
  medium,

  /// 0.90
  high,
}

/// Immutable per-category toggle state.
class CategoryToggles {
  /// Creates category toggles.
  const CategoryToggles({
    required this.nudity,
    required this.violence,
    required this.kissing,
    required this.profanity,
    required this.lgbtq,
  });

  /// All filters enabled (factory default).
  factory CategoryToggles.defaults() => const CategoryToggles(
        nudity: true,
        violence: true,
        kissing: true,
        profanity: true,
        lgbtq: true,
      );

  /// Nudity filter on.
  final bool nudity;

  /// Violence filter on.
  final bool violence;

  /// Kissing / romantic filter on.
  final bool kissing;

  /// Profanity filter on.
  final bool profanity;

  /// LGBTQ+ themes filter on.
  final bool lgbtq;

  /// Category keys enabled for inference (backend route names).
  List<String> enabledNames() {
    final names = <String>[];
    if (nudity) names.add('nudity');
    if (violence) names.add('violence');
    if (kissing) names.add('kissing');
    if (profanity) names.add('profanity');
    if (lgbtq) names.add('lgbtq');
    return names;
  }

  @override
  bool operator ==(Object other) =>
      other is CategoryToggles &&
      nudity == other.nudity &&
      violence == other.violence &&
      kissing == other.kissing &&
      profanity == other.profanity &&
      lgbtq == other.lgbtq;

  @override
  int get hashCode => Object.hash(nudity, violence, kissing, profanity, lgbtq);
}

/// Snapshot of all persisted settings (read-only aggregate).
class SafeViewSettingsSnapshot {
  /// Full settings read from disk.
  const SafeViewSettingsSnapshot({
    required this.protectionEnabled,
    required this.activeMode,
    required this.backendUrl,
    required this.sensitivity,
    required this.categories,
    required this.profanityWords,
  });

  /// Protection master switch.
  final bool protectionEnabled;

  /// Browser vs overlay mode.
  final SafeViewMode activeMode;

  /// FastAPI base URL.
  final String backendUrl;

  /// User sensitivity 0.0–1.0.
  final double sensitivity;

  /// Per-category toggles.
  final CategoryToggles categories;

  /// Profanity blacklist (BR-03).
  final List<String> profanityWords;

  /// BR-01 effective threshold for this snapshot.
  double get effectiveThreshold =>
      SettingsService.computeEffectiveThreshold(sensitivity);
}

/// Default sensitivity (Medium), aligned with extension.
const double defaultSensitivity = 0.75;

/// Sensitivity stop values for slider UI.
const double sensitivityLow = 0.6;
const double sensitivityMedium = 0.75;
const double sensitivityHigh = 0.9;

/// Reads and writes SafeView user settings (no frame data stored).
class SettingsService {
  /// Creates a service backed by [prefs].
  SettingsService(this._prefs);

  final SharedPreferences _prefs;

  /// Opens SharedPreferences and returns a [SettingsService].
  static Future<SettingsService> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      return SettingsService(prefs);
    } catch (error, stack) {
      logError(error, stack);
      rethrow;
    }
  }

  // ── Protection & mode ─────────────────────────────────────────────────────

  /// Whether protection is globally enabled (default false until user enables).
  bool get protectionEnabled =>
      _prefs.getBool(SettingsKeys.protectionEnabled) ?? false;

  /// Sets protection enabled flag.
  Future<void> setProtectionEnabled(bool value) async {
    await _prefs.setBool(SettingsKeys.protectionEnabled, value);
  }

  /// Current mode (browser vs overlay); default browser.
  SafeViewMode get activeMode {
    final raw = _prefs.getString(SettingsKeys.activeMode);
    return raw == 'overlay' ? SafeViewMode.overlay : SafeViewMode.browser;
  }

  /// Persists active mode.
  Future<void> setActiveMode(SafeViewMode mode) async {
    await _prefs.setString(
      SettingsKeys.activeMode,
      mode == SafeViewMode.overlay ? 'overlay' : 'browser',
    );
  }

  // ── Backend URL ───────────────────────────────────────────────────────────

  /// FastAPI base URL (default emulator loopback).
  String get backendUrl =>
      _prefs.getString(SettingsKeys.backendUrl) ?? defaultBackendUrlEmulator;

  /// Updates backend URL (trimmed; empty reverts to default on next read).
  Future<void> setBackendUrl(String url) async {
    final trimmed = url.trim();
    if (trimmed.isEmpty) {
      await _prefs.remove(SettingsKeys.backendUrl);
      return;
    }
    await _prefs.setString(SettingsKeys.backendUrl, trimmed);
  }

  // ── Sensitivity ───────────────────────────────────────────────────────────

  /// User sensitivity 0.0–1.0 (default Medium = 0.75).
  double get sensitivity =>
      _prefs.getDouble(SettingsKeys.sensitivity) ?? defaultSensitivity;

  /// Persists raw sensitivity value.
  Future<void> setSensitivity(double value) async {
    await _prefs.setDouble(SettingsKeys.sensitivity, value.clamp(0.0, 1.0));
  }

  /// Current sensitivity as a labelled preset (nearest stop).
  SensitivityPreset get sensitivityPreset => presetForValue(sensitivity);

  /// Sets sensitivity from [SensitivityPreset] stop.
  Future<void> setSensitivityPreset(SensitivityPreset preset) async {
    await setSensitivity(valueForPreset(preset));
  }

  /// Maps a stored value to the nearest slider preset.
  static SensitivityPreset presetForValue(double value) {
    const stops = <double>[sensitivityLow, sensitivityMedium, sensitivityHigh];
    var best = SensitivityPreset.medium;
    var minDist = double.infinity;
    for (var i = 0; i < stops.length; i++) {
      final dist = (value - stops[i]).abs();
      if (dist < minDist) {
        minDist = dist;
        best = SensitivityPreset.values[i];
      }
    }
    return best;
  }

  /// Numeric value for [preset].
  static double valueForPreset(SensitivityPreset preset) {
    switch (preset) {
      case SensitivityPreset.low:
        return sensitivityLow;
      case SensitivityPreset.medium:
        return sensitivityMedium;
      case SensitivityPreset.high:
        return sensitivityHigh;
    }
  }

  // ── Per-category toggles (typed) ──────────────────────────────────────────

  /// Nudity filter enabled (default true).
  bool get filterNudityEnabled =>
      _prefs.getBool(SettingsKeys.filterNudity) ?? true;

  /// Sets nudity filter.
  Future<void> setFilterNudityEnabled(bool value) async {
    await _prefs.setBool(SettingsKeys.filterNudity, value);
  }

  /// Violence filter enabled (default true).
  bool get filterViolenceEnabled =>
      _prefs.getBool(SettingsKeys.filterViolence) ?? true;

  /// Sets violence filter.
  Future<void> setFilterViolenceEnabled(bool value) async {
    await _prefs.setBool(SettingsKeys.filterViolence, value);
  }

  /// Kissing / romantic filter enabled (default true).
  bool get filterKissingEnabled =>
      _prefs.getBool(SettingsKeys.filterKissing) ?? true;

  /// Sets kissing filter.
  Future<void> setFilterKissingEnabled(bool value) async {
    await _prefs.setBool(SettingsKeys.filterKissing, value);
  }

  /// Profanity filter enabled (default true).
  bool get filterProfanityEnabled =>
      _prefs.getBool(SettingsKeys.filterProfanity) ?? true;

  /// Sets profanity filter.
  Future<void> setFilterProfanityEnabled(bool value) async {
    await _prefs.setBool(SettingsKeys.filterProfanity, value);
  }

  /// LGBTQ+ themes filter enabled (default true).
  bool get filterLgbtqEnabled =>
      _prefs.getBool(SettingsKeys.filterLgbtq) ?? true;

  /// Sets LGBTQ+ filter.
  Future<void> setFilterLgbtqEnabled(bool value) async {
    await _prefs.setBool(SettingsKeys.filterLgbtq, value);
  }

  /// All category toggles as an immutable object.
  CategoryToggles get categoryToggles => CategoryToggles(
        nudity: filterNudityEnabled,
        violence: filterViolenceEnabled,
        kissing: filterKissingEnabled,
        profanity: filterProfanityEnabled,
        lgbtq: filterLgbtqEnabled,
      );

  /// Persists all category toggles at once.
  Future<void> setCategoryToggles(CategoryToggles toggles) async {
    await Future.wait([
      setFilterNudityEnabled(toggles.nudity),
      setFilterViolenceEnabled(toggles.violence),
      setFilterKissingEnabled(toggles.kissing),
      setFilterProfanityEnabled(toggles.profanity),
      setFilterLgbtqEnabled(toggles.lgbtq),
    ]);
  }

  /// Typed getter for [category].
  bool isCategoryEnabled(FilterCategory category) {
    switch (category) {
      case FilterCategory.nudity:
        return filterNudityEnabled;
      case FilterCategory.violence:
        return filterViolenceEnabled;
      case FilterCategory.kissing:
        return filterKissingEnabled;
      case FilterCategory.profanity:
        return filterProfanityEnabled;
      case FilterCategory.lgbtq:
        return filterLgbtqEnabled;
    }
  }

  /// Typed setter for [category].
  Future<void> setCategoryEnabled(FilterCategory category, bool value) async {
    switch (category) {
      case FilterCategory.nudity:
        await setFilterNudityEnabled(value);
      case FilterCategory.violence:
        await setFilterViolenceEnabled(value);
      case FilterCategory.kissing:
        await setFilterKissingEnabled(value);
      case FilterCategory.profanity:
        await setFilterProfanityEnabled(value);
      case FilterCategory.lgbtq:
        await setFilterLgbtqEnabled(value);
    }
  }

  /// Backend category strings for enabled filters only.
  List<String> get enabledCategoryNames => categoryToggles.enabledNames();

  /// Count of enabled filters (dashboard badge).
  int get enabledFilterCount => enabledCategoryNames.length;

  // ── Profanity list (BR-03) ────────────────────────────────────────────────

  /// Profanity word list; empty by default.
  List<String> get profanityWords {
    final raw = _prefs.getStringList(SettingsKeys.profanityWords);
    return raw == null ? List<String>.unmodifiable([]) : List.unmodifiable(raw);
  }

  /// Saves profanity list immediately (no restart required).
  Future<void> setProfanityWords(List<String> words) async {
    await _prefs.setStringList(
      SettingsKeys.profanityWords,
      words.map((w) => w.trim()).where((w) => w.isNotEmpty).toList(),
    );
  }

  /// Appends a word if not already present.
  Future<void> addProfanityWord(String word) async {
    final trimmed = word.trim();
    if (trimmed.isEmpty) return;
    final current = profanityWords.toList();
    if (!current.contains(trimmed)) {
      current.add(trimmed);
      await setProfanityWords(current);
    }
  }

  /// Removes a word from the list.
  Future<void> removeProfanityWord(String word) async {
    final current = profanityWords.toList()..remove(word);
    await setProfanityWords(current);
  }

  // ── Aggregate / defaults ───────────────────────────────────────────────────

  /// Reads all settings into one snapshot.
  SafeViewSettingsSnapshot get snapshot => SafeViewSettingsSnapshot(
        protectionEnabled: protectionEnabled,
        activeMode: activeMode,
        backendUrl: backendUrl,
        sensitivity: sensitivity,
        categories: categoryToggles,
        profanityWords: profanityWords,
      );

  /// BR-01: `max(0.75, userSensitivity)` for current user setting.
  double effectiveThreshold() => computeEffectiveThreshold(sensitivity);

  /// BR-01 threshold helper.
  static double computeEffectiveThreshold(double userSensitivity) {
    return math.max(confidenceFloor, userSensitivity);
  }

  /// Restores all settings to project defaults (BR-04 baseline).
  Future<void> resetToDefaults() async {
    await Future.wait([
      setProtectionEnabled(false),
      setActiveMode(SafeViewMode.browser),
      _prefs.remove(SettingsKeys.backendUrl),
      setSensitivity(defaultSensitivity),
      setCategoryToggles(CategoryToggles.defaults()),
      setProfanityWords([]),
    ]);
  }

  /// Logs settings errors with SafeView prefix.
  static void logError(Object error, StackTrace stack) {
    debugPrint('[SafeView] SettingsService error: $error');
    debugPrint(stack.toString());
  }
}
