import '../api/api_client.dart';

/// A task an agent posted, as a person sees it before and after taking it.
class AgentTask {
  const AgentTask({
    required this.id,
    required this.title,
    required this.amountUsdc,
    required this.deliveryDays,
    required this.status,
    required this.statusText,
    required this.agentByline,
    this.description = '',
    this.takeable = false,
    this.agentHandle,
    this.hiredAndPaid = 0,
    this.hiredNotDelivered = 0,
    this.openUntil,
    this.transferId,
  });

  factory AgentTask.fromJson(Map<String, dynamic> j) {
    final agent = j['agent'] is Map
        ? Map<String, dynamic>.from(j['agent'] as Map)
        : const <String, dynamic>{};
    final record = agent['record'] is Map
        ? Map<String, dynamic>.from(agent['record'] as Map)
        : const <String, dynamic>{};
    return AgentTask(
      id: j['id']?.toString() ?? '',
      title: j['title']?.toString() ?? '',
      description: j['description']?.toString() ?? '',
      amountUsdc: (j['amountUsdc'] as num?)?.toDouble() ?? 0,
      deliveryDays: (j['deliveryDays'] as num?)?.toInt() ?? 7,
      status: j['status']?.toString() ?? '',
      statusText: j['statusText']?.toString() ?? '',
      takeable: j['takeable'] == true,
      agentByline: agent['byline']?.toString() ?? 'An agent',
      agentHandle: agent['handle']?.toString(),
      hiredAndPaid: (record['hiredAndPaid'] as num?)?.toInt() ?? 0,
      hiredNotDelivered: (record['hiredNotDelivered'] as num?)?.toInt() ?? 0,
      openUntil: DateTime.tryParse(j['openUntil']?.toString() ?? ''),
      transferId: j['transferId']?.toString(),
    );
  }

  final String id;
  final String title;
  final String description;
  final double amountUsdc;
  final int deliveryDays;
  final String status;
  final String statusText;
  final bool takeable;

  /// "Research agent · owned by @ada".
  final String agentByline;
  final String? agentHandle;

  /// How this agent has treated people it hired before.
  final int hiredAndPaid;
  final int hiredNotDelivered;
  final DateTime? openUntil;

  /// The hold, once the money is set aside for this person.
  final String? transferId;

  String get agentRecord => hiredAndPaid + hiredNotDelivered == 0
      ? 'Has not hired anyone yet'
      : 'Paid $hiredAndPaid of ${hiredAndPaid + hiredNotDelivered} people it hired';

  bool get moneySetAside => status == 'held' || status == 'paid';
}

class AgentTasksApi {
  AgentTasksApi(this._api);

  final ApiClient _api;

  Future<List<AgentTask>> open() async {
    final res = await _api.get('/v1/agent-tasks/open');
    return _list(res);
  }

  Future<List<AgentTask>> mine() async {
    final res = await _api.get('/v1/agent-tasks/mine');
    return _list(res);
  }

  /// The person's own copy when they took it (it carries the hold), else
  /// the public view anyone with the link sees.
  Future<AgentTask> view(String id) async {
    try {
      final own = (await mine()).where((t) => t.id == id);
      if (own.isNotEmpty) return own.first;
    } catch (_) {
      // Not signed in, or not theirs: the public view still works.
    }
    return AgentTask.fromJson(await _api.get('/v1/public/tasks/$id'));
  }

  Future<AgentTask> take(String id) async {
    final res = await _api.post('/v1/agent-tasks/$id/take');
    return AgentTask.fromJson(Map<String, dynamic>.from(res['task'] as Map));
  }

  List<AgentTask> _list(Map<String, dynamic> res) => [
        for (final t in (res['items'] as List? ?? const []))
          if (t is Map) AgentTask.fromJson(Map<String, dynamic>.from(t))
      ];
}
