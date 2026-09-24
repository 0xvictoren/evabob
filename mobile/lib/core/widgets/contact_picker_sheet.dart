import 'package:flutter/material.dart';

import '../contacts/device_contacts.dart';
import '../theme/evabob_colors.dart';
import 'glass.dart';

/// Bottom sheet: pick a device contact email (phone is not a payee).
class ContactPickerSheet extends StatefulWidget {
  const ContactPickerSheet({super.key});

  static Future<String?> open(BuildContext context) {
    return showModalBottomSheet<String>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => const ContactPickerSheet(),
    );
  }

  @override
  State<ContactPickerSheet> createState() => _ContactPickerSheetState();
}

class _ContactPickerSheetState extends State<ContactPickerSheet> {
  bool _loading = true;
  String? _error;
  List<DeviceContact> _items = [];
  String _query = '';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final list = (await DeviceContactsHelper.load())
          .where((c) => (c.email ?? '').contains('@'))
          .toList();
      if (!mounted) return;
      setState(() {
        _items = list;
        _loading = false;
        if (list.isEmpty) {
          _error = 'No contacts with email, or permission denied';
        }
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final q = _query.trim().toLowerCase();
    final filtered = q.isEmpty
        ? _items
        : _items
            .where(
              (c) =>
                  c.displayName.toLowerCase().contains(q) ||
                  (c.email?.toLowerCase().contains(q) ?? false),
            )
            .toList();

    return DraggableScrollableSheet(
      initialChildSize: 0.72,
      minChildSize: 0.4,
      maxChildSize: 0.92,
      builder: (context, scroll) {
        return Padding(
          padding: const EdgeInsets.all(12),
          child: Glass(
            heavy: true,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const Text(
                  'Contacts',
                  style: TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w400,
                    color: EvabobColors.navy,
                  ),
                ),
                const SizedBox(height: 4),
                const Text(
                  'Pick an email. Phone numbers are not payees.',
                  style: TextStyle(fontSize: 10, color: EvabobColors.navyMuted),
                ),
                const SizedBox(height: 12),
                TextField(
                  onChanged: (v) => setState(() => _query = v),
                  decoration: const InputDecoration(
                    hintText: 'Search',
                    prefixIcon: Icon(Icons.search_rounded),
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
                const SizedBox(height: 8),
                if (_loading)
                  const Expanded(
                    child: Center(child: CircularProgressIndicator()),
                  )
                else if (_error != null && filtered.isEmpty)
                  Expanded(
                    child: Center(
                      child: Padding(
                        padding: const EdgeInsets.all(16),
                        child: Text(
                          _error!,
                          textAlign: TextAlign.center,
                          style: const TextStyle(color: EvabobColors.navyMuted),
                        ),
                      ),
                    ),
                  )
                else
                  Expanded(
                    child: ListView.builder(
                      controller: scroll,
                      itemCount: filtered.length,
                      itemBuilder: (context, i) {
                        final c = filtered[i];
                        return ListTile(
                          leading: CircleAvatar(
                            backgroundColor:
                                EvabobColors.emerald.withValues(alpha: 0.15),
                            child: Text(
                              c.displayName.characters.first.toUpperCase(),
                              style: TextStyle(
                                color: EvabobColors.emeraldDeep,
                                fontWeight: FontWeight.w400,
                              ),
                            ),
                          ),
                          title: Text(c.displayName),
                          subtitle: Text(
                            c.email ?? '',
                            style: const TextStyle(fontSize: 10),
                          ),
                          onTap: () {
                            final value = c.email ?? '';
                            if (value.isEmpty) return;
                            Navigator.pop(context, value);
                          },
                        );
                      },
                    ),
                  ),
              ],
            ),
          ),
        );
      },
    );
  }
}
