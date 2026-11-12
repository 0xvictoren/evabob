import 'package:geolocator/geolocator.dart';

/// Why the device could not say where it is, in words for the person.
class LocationProblem implements Exception {
  const LocationProblem(this.message);
  final String message;

  @override
  String toString() => message;
}

/// A position rounded to about a kilometre.
typedef MapPoint = ({double lat, double lng});

/// Asks the phone or the browser where the person is, once, when they tap.
///
/// The position is rounded to two decimal places (about a kilometre) before
/// it leaves this class, so nothing precise enough to find a door is ever
/// sent to the server. Nothing is tracked in the background.
class DeviceLocation {
  DeviceLocation._();

  static double _round(double v) => (v * 100).roundToDouble() / 100;

  static Future<MapPoint> here() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) {
        throw const LocationProblem(
            'Location is switched off on this device. Turn it on and try again.');
      }
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied) {
        throw const LocationProblem(
            'Location was not allowed. You can still choose your state and area.');
      }
      if (permission == LocationPermission.deniedForever) {
        throw const LocationProblem(
            'Location is blocked for Evabob. Allow it in your settings, or '
            'choose your state and area instead.');
      }
      final p = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.low,
          timeLimit: Duration(seconds: 20),
        ),
      );
      return (lat: _round(p.latitude), lng: _round(p.longitude));
    } on LocationProblem {
      rethrow;
    } catch (_) {
      throw const LocationProblem(
          'Could not find where you are. Try again, or choose your state and area.');
    }
  }

  /// The point saved in a place from the server, if it has one.
  static MapPoint? fromPlace(Object? place) {
    if (place is! Map) return null;
    final lat = place['lat'];
    final lng = place['lng'];
    if (lat is! num || lng is! num) return null;
    return (lat: lat.toDouble(), lng: lng.toDouble());
  }

  /// A place body for the server: names, plus the point when there is one.
  static Map<String, dynamic> place({
    String? state,
    String? area,
    MapPoint? point,
  }) =>
      {
        'state': state ?? '',
        'area': (area ?? '').trim(),
        if (point != null) 'lat': point.lat,
        if (point != null) 'lng': point.lng,
      };
}
