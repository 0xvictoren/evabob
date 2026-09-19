# Evabob Mobile

Flutter app for Android Studio testing (beige + emerald glass).

## Open in Android Studio (recommended)

```powershell
cd C:\Users\victoren\Desktop\Projects\evabob\mobile
.\open_in_android_studio.ps1
```

Then: start an emulator → **Run ▶**

Full guide: [ANDROID_STUDIO.md](./ANDROID_STUDIO.md)

## CLI

```powershell
$env:PATH = "C:\Users\victoren\develop\flutter\bin;$env:PATH"
cd C:\Users\victoren\Desktop\Projects\evabob\mobile
flutter pub get
flutter run
```

The checked-in `dart_defines.json` is for local debug use and may name a local
HTTP API. Android release and profile manifests reject cleartext traffic.
Release builds additionally fail unless `API_BASE_URL` is an exact HTTPS
origin. Build a distributable only after the hosted API is healthy:

```powershell
Copy-Item dart_defines.render.example.json dart_defines.testnet.json
# Confirm/update API_BASE_URL, then:
flutter build appbundle --release --dart-define-from-file=dart_defines.testnet.json
```

`dart_defines.testnet.json` is ignored by Git so deployment-specific public
configuration can be maintained without changing the local debug file.

### Windows desktop

Requires **Developer Mode** (Settings → System → For developers). Then:

```powershell
flutter run -d windows
```

Or use **Chrome**: `flutter run -d chrome`

**Auto demo login** is ON by default (lands on Home immediately).
## Quick test path

1. Home balance in ₦  
2. Chat → Adaobi → `@. send 3500 naira with description food`  
3. Exchange → EUR ↔ USDC  
4. Send (center button) → keypad arithmetic `120+35`  
