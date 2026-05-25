// SafeView — settings_screen.dart
// Authors: Blen Bizuayehu, Lidiya Getale, Bisrat Teshome
// Bahir Dar Institute of Technology — Software Engineering Capstone, 2018 EC
// Purpose: Category toggles, sensitivity, backend URL test, permissions deep-links.

import 'package:flutter/material.dart';
import 'package:safeview/constants.dart';
import 'package:safeview/services/ai_client.dart';
import 'package:safeview/services/permissions_service.dart';
import 'package:safeview/services/settings_service.dart';
import 'package:safeview/widgets/category_toggle.dart';

/// Settings UI matching extension options (categories, sensitivity, backend).
class SettingsScreen extends StatefulWidget {
  /// Creates settings screen.
  const SettingsScreen({super.key});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> with WidgetsBindingObserver {
  final PermissionsService _permissionsService = PermissionsService();
  SettingsService? _settings;
  PermissionStatusSnapshot? _permissions;

  final TextEditingController _backendController = TextEditingController();
  bool? _backendOk;
  String? _backendError;
  bool _testing = false;

  static const List<String> _sensitivityLabels = ['Low', 'Medium', 'High'];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _load();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _refreshPermissions();
    }
  }

  Future<void> _load() async {
    try {
      final settings = await SettingsService.load();
      _backendController.text = settings.backendUrl;
      await _refreshPermissions();
      if (mounted) setState(() => _settings = settings);
    } catch (error, stack) {
      SettingsService.logError(error, stack);
    }
  }

  Future<void> _refreshPermissions() async {
    final status = await _permissionsService.getStatus();
    if (mounted) setState(() => _permissions = status);
  }

  Future<void> _testConnection() async {
    setState(() {
      _testing = true;
      _backendOk = null;
      _backendError = null;
    });
    final url = _backendController.text.trim();
    final client = AiClient(baseUrl: url);
    final ok = await client.checkHealth();
    if (_settings != null) {
      await _settings!.setBackendUrl(url);
    }
    if (mounted) {
      setState(() {
        _backendOk = ok;
        _backendError = ok ? null : AiClient.backendStatus.lastError;
        _testing = false;
      });
    }
  }

  bool get _usesEmulatorLoopback =>
      _backendController.text.contains('10.0.2.2');

  Future<void> _resetDefaults() async {
    await _settings?.resetToDefaults();
    _backendController.text = defaultBackendUrlEmulator;
    if (!mounted) return;
    setState(() {});
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Settings reset to defaults.')),
    );
  }

  int _sensitivityIndex(SettingsService s) => s.sensitivityPreset.index;

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _backendController.dispose();
    super.dispose();
  }

  Widget _permissionTile({
    required String title,
    required String subtitle,
    required bool granted,
    required VoidCallback onOpenSettings,
  }) {
    return Card(
      color: SafeViewColors.background,
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        title: Text(title, style: const TextStyle(color: SafeViewColors.text)),
        subtitle: Text(subtitle, style: const TextStyle(color: Colors.white54)),
        leading: Icon(
          granted ? Icons.check_circle : Icons.error_outline,
          color: granted ? SafeViewColors.active : SafeViewColors.warning,
        ),
        trailing: TextButton(
          onPressed: onOpenSettings,
          child: const Text('Open Settings'),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_settings == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }

    final s = _settings!;
    final perms = _permissions;

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          const Text(
            'Filters',
            style: TextStyle(color: SafeViewColors.accent, fontSize: 18),
          ),
          CategoryToggle(
            title: 'Nudity',
            value: s.filterNudityEnabled,
            onChanged: (v) async {
              await s.setFilterNudityEnabled(v);
              setState(() {});
            },
          ),
          CategoryToggle(
            title: 'Violence',
            value: s.filterViolenceEnabled,
            onChanged: (v) async {
              await s.setFilterViolenceEnabled(v);
              setState(() {});
            },
          ),
          CategoryToggle(
            title: 'Kissing / Romantic',
            value: s.filterKissingEnabled,
            onChanged: (v) async {
              await s.setFilterKissingEnabled(v);
              setState(() {});
            },
          ),
          CategoryToggle(
            title: 'Profanity',
            value: s.filterProfanityEnabled,
            onChanged: (v) async {
              await s.setFilterProfanityEnabled(v);
              setState(() {});
            },
          ),
          CategoryToggle(
            title: 'LGBTQ+ Themes',
            value: s.filterLgbtqEnabled,
            onChanged: (v) async {
              await s.setFilterLgbtqEnabled(v);
              setState(() {});
            },
          ),
          const SizedBox(height: 16),
          const Text(
            'Sensitivity',
            style: TextStyle(color: SafeViewColors.accent, fontSize: 18),
          ),
          Text(
            '${_sensitivityLabels[_sensitivityIndex(s)]} (${s.sensitivity})',
            style: const TextStyle(color: SafeViewColors.text),
          ),
          Slider(
            value: _sensitivityIndex(s).toDouble(),
            min: 0,
            max: 2,
            divisions: 2,
            label: _sensitivityLabels[_sensitivityIndex(s)],
            activeColor: SafeViewColors.accent,
            onChanged: (index) async {
              await s.setSensitivityPreset(
                SensitivityPreset.values[index.round()],
              );
              setState(() {});
            },
          ),
          const SizedBox(height: 16),
          const Text(
            'Backend',
            style: TextStyle(color: SafeViewColors.accent, fontSize: 18),
          ),
          TextField(
            controller: _backendController,
            style: const TextStyle(color: SafeViewColors.text),
            decoration: const InputDecoration(
              labelText: 'Backend URL',
              hintText: defaultBackendUrlDevice,
              helperText:
                  'Emulator: http://10.0.2.2:8000 · Physical phone: http://<PC_LAN_IP>:8000',
              labelStyle: TextStyle(color: SafeViewColors.accent),
              hintStyle: TextStyle(color: Colors.white38),
              helperStyle: TextStyle(color: Colors.white54, fontSize: 12),
              border: OutlineInputBorder(),
            ),
            onSubmitted: (_) => _testConnection(),
          ),
          if (_usesEmulatorLoopback)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text(
                '10.0.2.2 only works on the Android emulator. On a real phone, use your PC\'s LAN IP.',
                style: TextStyle(color: SafeViewColors.warning, fontSize: 13),
              ),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed: _testing ? null : _testConnection,
                  child: Text(_testing ? 'Testing…' : 'Test Connection'),
                ),
              ),
            ],
          ),
          if (_backendOk == true)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text(
                'Backend reachable',
                style: TextStyle(color: SafeViewColors.active),
              ),
            ),
          if (_backendOk == false)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(
                _backendError == null
                    ? 'Backend unreachable — fail-open (no blur on errors)'
                    : 'Backend unreachable — fail-open (no blur on errors)\n$_backendError',
                style: const TextStyle(color: SafeViewColors.warning),
              ),
            ),
          const SizedBox(height: 24),
          const Text(
            'Permissions',
            style: TextStyle(color: SafeViewColors.accent, fontSize: 18),
          ),
          if (perms != null) ...[
            _permissionTile(
              title: 'Display over other apps',
              subtitle: 'Required for screen overlay mode',
              granted: perms.overlayGranted,
              onOpenSettings: _permissionsService.openOverlaySettings,
            ),
            _permissionTile(
              title: 'Notifications',
              subtitle: 'Required for foreground overlay service',
              granted: perms.notificationsGranted,
              onOpenSettings: _permissionsService.openNotificationSettings,
            ),
            _permissionTile(
              title: 'Internet',
              subtitle: 'Connects to your local FastAPI backend only',
              granted: perms.internetGranted,
              onOpenSettings: _permissionsService.openAppSettings,
            ),
            if (!perms.overlayModeReady)
              const Padding(
                padding: EdgeInsets.only(top: 4),
                child: Text(
                  'Grant missing permissions before starting overlay capture.',
                  style: TextStyle(color: SafeViewColors.warning, fontSize: 13),
                ),
              ),
          ] else
            const Center(child: CircularProgressIndicator()),
          const SizedBox(height: 24),
          OutlinedButton(
            onPressed: _resetDefaults,
            child: const Text('Reset to defaults'),
          ),
        ],
      ),
    );
  }
}
