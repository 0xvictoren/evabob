enum TxKind { subscription, send, receive, exchange, purchase }

class ActivityItem {
  const ActivityItem({
    required this.name,
    required this.description,
    required this.amountNgn,
    required this.date,
    required this.kind,
  });

  final String name;
  final String description;

  /// Display amount in Naira (local). Positive = in, negative = out.
  final double amountNgn;
  final String date;
  final TxKind kind;
}

/// Everyday money activity only — never escrow/settlement jargon.
const kActivity = <ActivityItem>[
  ActivityItem(
    name: 'Spotify Subscription',
    description: 'Paid for 1 month',
    amountNgn: -17900,
    date: 'Today · 14:22',
    kind: TxKind.subscription,
  ),
  ActivityItem(
    name: 'Sent to Adaobi via chat',
    description: 'Food money',
    amountNgn: -3500,
    date: 'Today · 11:05',
    kind: TxKind.send,
  ),
  ActivityItem(
    name: 'Received from Chinedu',
    description: 'Rent share',
    amountNgn: 85000,
    date: 'Yesterday',
    kind: TxKind.receive,
  ),
  ActivityItem(
    name: 'Euros changed to dollars',
    description: 'Converted €50',
    amountNgn: 75338, // ~$54.20 * 1390
    date: 'Yesterday',
    kind: TxKind.exchange,
  ),
  ActivityItem(
    name: 'Netflix Subscription',
    description: 'Monthly plan',
    amountNgn: -26000,
    date: 'Jul 12',
    kind: TxKind.subscription,
  ),
  ActivityItem(
    name: 'Sent to Maya',
    description: 'Concert tickets',
    amountNgn: -68000,
    date: 'Jul 11',
    kind: TxKind.send,
  ),
  ActivityItem(
    name: 'Zara',
    description: 'In-store purchase',
    amountNgn: -145000,
    date: 'Jul 9',
    kind: TxKind.purchase,
  ),
];
