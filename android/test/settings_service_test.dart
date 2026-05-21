// SafeView — settings_service_test.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Unit tests for SettingsService read/write via SharedPreferences.

import 'package:flutter_test/flutter_test.dart';
import 'package:safeview/constants.dart';
import 'package:safeview/services/settings_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('SettingsService read/write', () {
    test('defaults match project baseline', () async {
      final service = await SettingsService.load();

      expect(service.protectionEnabled, isFalse);
      expect(service.activeMode, SafeViewMode.browser);
      expect(service.backendUrl, defaultBackendUrlEmulator);
      expect(service.sensitivity, defaultSensitivity);
      expect(service.filterNudityEnabled, isTrue);
      expect(service.enabledFilterCount, 5);
      expect(service.profanityWords, isEmpty);
    });

    test('writes and reads back all primary settings', () async {
      final service = await SettingsService.load();

      await service.setProtectionEnabled(true);
      await service.setActiveMode(SafeViewMode.overlay);
      await service.setBackendUrl('http://192.168.0.10:8000');
      await service.setSensitivityPreset(SensitivityPreset.medium);
      await service.setFilterNudityEnabled(true);
      await service.setFilterViolenceEnabled(false);

      final reloaded = await SettingsService.load();
      expect(reloaded.protectionEnabled, isTrue);
      expect(reloaded.activeMode, SafeViewMode.overlay);
      expect(reloaded.backendUrl, 'http://192.168.0.10:8000');
      expect(reloaded.sensitivity, sensitivityMedium);
      expect(reloaded.filterNudityEnabled, isTrue);
      expect(reloaded.filterViolenceEnabled, isFalse);
      expect(reloaded.enabledCategoryNames, contains('nudity'));
      expect(reloaded.enabledCategoryNames, isNot(contains('violence')));
    });

    test('category toggles persist independently', () async {
      final service = await SettingsService.load();
      await service.setFilterNudityEnabled(false);
      await service.setFilterKissingEnabled(false);

      final reloaded = await SettingsService.load();
      expect(reloaded.filterNudityEnabled, isFalse);
      expect(reloaded.filterKissingEnabled, isFalse);
      expect(reloaded.filterProfanityEnabled, isTrue);
      expect(reloaded.enabledFilterCount, 3);
    });

    test('setCategoryToggles round-trips through reload', () async {
      const toggles = CategoryToggles(
        nudity: true,
        violence: false,
        kissing: false,
        profanity: true,
        lgbtq: false,
      );

      final service = await SettingsService.load();
      await service.setCategoryToggles(toggles);

      final reloaded = await SettingsService.load();
      expect(reloaded.categoryToggles, toggles);
      expect(reloaded.snapshot.categories, toggles);
    });

    test('profanity list add, remove, and reload', () async {
      final service = await SettingsService.load();
      await service.setProfanityWords(['bad']);
      await service.addProfanityWord('worse');

      final reloaded = await SettingsService.load();
      expect(reloaded.profanityWords, ['bad', 'worse']);

      await reloaded.removeProfanityWord('bad');
      final again = await SettingsService.load();
      expect(again.profanityWords, ['worse']);
    });

    test('effectiveThreshold applies BR-01 floor', () async {
      final service = await SettingsService.load();
      await service.setSensitivity(0.1);
      expect(service.effectiveThreshold(), confidenceFloor);

      await service.setSensitivity(0.9);
      expect(service.effectiveThreshold(), 0.9);
    });

    test('resetToDefaults restores baseline after reload', () async {
      final service = await SettingsService.load();
      await service.setProtectionEnabled(true);
      await service.setBackendUrl('http://custom:9999');
      await service.setFilterNudityEnabled(false);
      await service.setSensitivityPreset(SensitivityPreset.low);
      await service.resetToDefaults();

      final reloaded = await SettingsService.load();
      expect(reloaded.protectionEnabled, isFalse);
      expect(reloaded.backendUrl, defaultBackendUrlEmulator);
      expect(reloaded.filterNudityEnabled, isTrue);
      expect(reloaded.sensitivity, defaultSensitivity);
    });
  });
}
