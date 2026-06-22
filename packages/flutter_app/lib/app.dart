import 'package:flutter/material.dart';
import 'pages/admin_page.dart';
import 'pages/connect_page.dart';
import 'pages/settings_page.dart';
import 'services/storage_service.dart';

class EphemApp extends StatefulWidget {
  const EphemApp({super.key});

  @override
  State<EphemApp> createState() => _EphemAppState();
}

class _EphemAppState extends State<EphemApp> {
  int _currentIndex = 0;
  final _storage = StorageService();

  // 连接页需要这些值，存到 state 里让页面能拿到
  String _server = StorageService.defaultServer;
  String _username = '';

  @override
  void initState() {
    super.initState();
    _loadSettings();
  }

  Future<void> _loadSettings() async {
    _server = await _storage.getServer();
    _username = await _storage.getUsername();
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Ephem',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorSchemeSeed: const Color(0xFF6EA8FE),
        brightness: Brightness.dark,
      ),
      home: Scaffold(
        body: IndexedStack(
          index: _currentIndex,
          children: [
            ConnectPage(
              storage: _storage,
              server: _server,
              username: _username,
              onSettingsTap: () => setState(() => _currentIndex = 2),
            ),
            AdminPage(
              storage: _storage,
              server: _server,
              onChanged: () => _loadSettings(),
            ),
            SettingsPage(
              storage: _storage,
              onChanged: () => _loadSettings(),
            ),
          ],
        ),
        bottomNavigationBar: NavigationBar(
          selectedIndex: _currentIndex,
          onDestinationSelected: (i) => setState(() => _currentIndex = i),
          destinations: const [
            NavigationDestination(
              icon: Icon(Icons.chat_bubble_outline),
              selectedIcon: Icon(Icons.chat_bubble),
              label: '连接',
            ),
            NavigationDestination(
              icon: Icon(Icons.admin_panel_settings_outlined),
              selectedIcon: Icon(Icons.admin_panel_settings),
              label: '管理',
            ),
            NavigationDestination(
              icon: Icon(Icons.settings_outlined),
              selectedIcon: Icon(Icons.settings),
              label: '设置',
            ),
          ],
        ),
      ),
    );
  }
}
