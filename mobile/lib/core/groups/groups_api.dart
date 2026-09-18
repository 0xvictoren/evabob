import '../api/api_client.dart';

/// One person in a money circle, as the app shows them.
class CircleMember {
  const CircleMember({
    required this.userId,
    required this.name,
    required this.joined,
    required this.behindUsdc,
    this.place,
    this.paidRound,
    this.paidUsdc,
  });

  factory CircleMember.fromJson(Map<String, dynamic> j) {
    final paid = j['paidOut'] is Map
        ? Map<String, dynamic>.from(j['paidOut'] as Map)
        : null;
    return CircleMember(
      userId: j['userId']?.toString() ?? '',
      name: j['name']?.toString() ?? '',
      joined: j['joined'] == true,
      behindUsdc: (j['behindUsdc'] as num?)?.toDouble() ?? 0,
      place: (j['place'] as num?)?.toInt(),
      paidRound: (paid?['round'] as num?)?.toInt(),
      paidUsdc: (paid?['amountUsdc'] as num?)?.toDouble(),
    );
  }

  final String userId;
  final String name;
  final bool joined;
  final double behindUsdc;

  /// Place in the payout queue, 1 = next. Null once paid.
  final int? place;
  final int? paidRound;
  final double? paidUsdc;

  bool get behind => behindUsdc > 0;
  bool get paid => paidRound != null;
}

class CircleRound {
  const CircleRound({
    required this.round,
    required this.recipient,
    required this.amountUsdc,
    required this.missed,
    required this.at,
  });

  factory CircleRound.fromJson(Map<String, dynamic> j) => CircleRound(
        round: (j['round'] as num?)?.toInt() ?? 0,
        recipient: j['recipient']?.toString() ?? '',
        amountUsdc: (j['amountUsdc'] as num?)?.toDouble() ?? 0,
        missed: ((j['missed'] as List?) ?? const [])
            .map((e) => e.toString())
            .toList(growable: false),
        at: DateTime.tryParse(j['at']?.toString() ?? '') ?? DateTime.now(),
      );

  final int round;
  final String recipient;
  final double amountUsdc;
  final List<String> missed;
  final DateTime at;
}

class MoneyCircle {
  const MoneyCircle({
    required this.id,
    required this.name,
    required this.state,
    required this.organizer,
    required this.isOrganizer,
    required this.contributionUsdc,
    required this.everyWords,
    required this.rounds,
    required this.roundsCollected,
    required this.potUsdc,
    required this.commitmentUsdc,
    required this.members,
    required this.history,
    this.me,
    this.nextCollectionAt,
  });

  factory MoneyCircle.fromJson(Map<String, dynamic> j) => MoneyCircle(
        id: j['id']?.toString() ?? '',
        name: j['name']?.toString() ?? '',
        state: j['state']?.toString() ?? 'forming',
        organizer: j['organizer']?.toString() ?? '',
        isOrganizer: j['isOrganizer'] == true,
        contributionUsdc: (j['contributionUsdc'] as num?)?.toDouble() ?? 0,
        everyWords: j['everyWords']?.toString() ?? '',
        rounds: (j['rounds'] as num?)?.toInt() ?? 0,
        roundsCollected: (j['roundsCollected'] as num?)?.toInt() ?? 0,
        potUsdc: (j['potUsdc'] as num?)?.toDouble() ?? 0,
        commitmentUsdc: (j['commitmentUsdc'] as num?)?.toDouble() ?? 0,
        nextCollectionAt:
            DateTime.tryParse(j['nextCollectionAt']?.toString() ?? ''),
        members: ((j['members'] as List?) ?? const [])
            .map((e) => CircleMember.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(growable: false),
        me: j['me'] is Map
            ? CircleMember.fromJson(Map<String, dynamic>.from(j['me'] as Map))
            : null,
        history: ((j['history'] as List?) ?? const [])
            .map((e) => CircleRound.fromJson(Map<String, dynamic>.from(e as Map)))
            .toList(growable: false),
      );

  final String id;
  final String name;

  /// forming, running, finished or cancelled.
  final String state;
  final String organizer;
  final bool isOrganizer;
  final double contributionUsdc;
  final String everyWords;
  final int rounds;
  final int roundsCollected;
  final double potUsdc;
  final double commitmentUsdc;
  final DateTime? nextCollectionAt;
  final List<CircleMember> members;
  final CircleMember? me;
  final List<CircleRound> history;

  bool get needsMyJoin => state == 'forming' && me != null && !me!.joined;
}

class GroupPot {
  const GroupPot({
    required this.id,
    required this.title,
    required this.description,
    required this.state,
    required this.organizer,
    required this.beneficiary,
    required this.targetUsdc,
    required this.raisedUsdc,
    required this.deadline,
    required this.contributors,
    required this.url,
    this.isOrganizer = false,
    this.myContributionUsdc = 0,
  });

  factory GroupPot.fromJson(Map<String, dynamic> j) => GroupPot(
        id: j['id']?.toString() ?? '',
        title: j['title']?.toString() ?? '',
        description: j['description']?.toString() ?? '',
        state: j['state']?.toString() ?? 'open',
        organizer: j['organizer']?.toString() ?? '',
        beneficiary: j['beneficiary']?.toString() ?? '',
        targetUsdc: (j['targetUsdc'] as num?)?.toDouble() ?? 0,
        raisedUsdc: (j['raisedUsdc'] as num?)?.toDouble() ?? 0,
        deadline:
            DateTime.tryParse(j['deadline']?.toString() ?? '') ?? DateTime.now(),
        contributors: (j['contributors'] as num?)?.toInt() ?? 0,
        url: j['url']?.toString() ?? '',
        isOrganizer: j['isOrganizer'] == true,
        myContributionUsdc: (j['myContributionUsdc'] as num?)?.toDouble() ?? 0,
      );

  final String id;
  final String title;
  final String description;

  /// open, released or refunding.
  final String state;
  final String organizer;
  final String beneficiary;
  final double targetUsdc;
  final double raisedUsdc;
  final DateTime deadline;
  final int contributors;
  final String url;
  final bool isOrganizer;
  final double myContributionUsdc;

  double get progress =>
      targetUsdc <= 0 ? 0 : (raisedUsdc / targetUsdc).clamp(0, 1).toDouble();
  bool get open => state == 'open' && deadline.isAfter(DateTime.now());
}

/// Either kind, as listed together.
sealed class Group {
  const Group();
}

class CircleGroup extends Group {
  const CircleGroup(this.circle);
  final MoneyCircle circle;
}

class PotGroup extends Group {
  const PotGroup(this.pot);
  final GroupPot pot;
}

Group groupFromJson(Map<String, dynamic> j) => j['kind'] == 'circle'
    ? CircleGroup(MoneyCircle.fromJson(j))
    : PotGroup(GroupPot.fromJson(j));

class GroupsApi {
  GroupsApi(this._api);

  final ApiClient _api;

  Future<List<Group>> list() async {
    final res = await _api.get('/v1/groups');
    return ((res['items'] as List?) ?? const [])
        .map((e) => groupFromJson(Map<String, dynamic>.from(e as Map)))
        .toList(growable: false);
  }

  Future<Group> get(String id) async {
    final res = await _api.get('/v1/groups/$id');
    return groupFromJson(Map<String, dynamic>.from(res['item'] as Map));
  }
}
