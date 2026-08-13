import React, { useState } from 'react';
import { UserCircle, LogOut, Laptop, KeyRound, Copy, Check, Loader2, AlertCircle, Globe, Pencil, CloudOff } from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import { useSettingsStore } from '../../store/useSettingsStore';
import { EditionBadge } from '../common/EditionBadge';
import { SyncSection } from './SyncSection';
import { Toggle } from './Toggle';

/**
 * Account tab — sign-in status, devices, and pairing. Deliberately has no
 * email/password form and no Turnstile widget: login is a browser flow (see
 * useAuthStore.openLogin / lib.rs's rdsql://auth/callback handler). The
 * website's /account page is the one and only place those live.
 */
export const AccountSettingsTab: React.FC = () => {
  const {
    status,
    email,
    entitlement,
    devices,
    currentDeviceId,
    error,
    cloudConfigured,
    openLogin,
    cancelLogin,
    redeemPairingCode,
    signOut,
    createPairingCode,
    renameDevice,
    revokeDevice,
  } = useAuthStore();

  const [pairingInput, setPairingInput] = useState('');
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showRevoked, setShowRevoked] = useState(false);

  const handleRedeem = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pairingInput.trim()) return;
    setPairingBusy(true);
    setPairingError(null);
    try {
      await redeemPairingCode(pairingInput.trim().toUpperCase());
      setPairingInput('');
    } catch (err: any) {
      setPairingError(err?.message || 'Invalid or expired code');
    } finally {
      setPairingBusy(false);
    }
  };

  const handleGenerateCode = async () => {
    setGenerating(true);
    try {
      const { code } = await createPairingCode();
      setGeneratedCode(code);
    } finally {
      setGenerating(false);
    }
  };

  const copyCode = () => {
    if (!generatedCode) return;
    navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const submitRename = async (deviceId: string) => {
    if (renameValue.trim()) await renameDevice(deviceId, renameValue.trim());
    setRenamingId(null);
  };

  const analyticsEnabled = useSettingsStore((s) => s.analyticsEnabled);
  const setAnalyticsEnabled = useSettingsStore((s) => s.setAnalyticsEnabled);
  const analyticsToggle = (
    <div className="pt-2 border-t border-[#1e293b]">
      <Toggle
        label="Anonymous usage analytics"
        description="Opt-in, aggregate feature usage only — e.g. which database engines you connect to. No hostnames, credentials, or query text, ever."
        checked={analyticsEnabled}
        onChange={setAnalyticsEnabled}
      />
    </div>
  );

  if (cloudConfigured === false) {
    return (
      <div className="flex flex-col gap-3 text-xs text-slate-400">
        <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <UserCircle className="w-4 h-4 text-blue-400" />
          Account
        </h3>
        <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-[#0f172a] border border-[#1e293b] text-slate-500">
          <CloudOff className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            Cloud sign-in and sync aren't available in this build. This is a self-built or community binary without
            the official backend configured.
          </div>
        </div>
      </div>
    );
  }

  if (status === 'signed-in') {
    return (
      <div className="flex flex-col gap-4 text-xs text-slate-400">
        <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
          <UserCircle className="w-4 h-4 text-blue-400" />
          Account
        </h3>

        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-[#0f172a] border border-[#1e293b]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-slate-200 truncate">{email}</span>
            {entitlement && <EditionBadge size="sm" />}
          </div>
          <button
            onClick={() => void signOut()}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-[#1e293b] hover:bg-[#263449] text-slate-300 transition-colors shrink-0"
          >
            <LogOut className="w-3 h-3" />
            Sign out
          </button>
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600 mb-2">Devices</div>
          <div className="space-y-1.5">
            {(showRevoked ? devices : devices.filter((d) => !d.revoked_at)).map((d) => (
              <div key={d.id} className="flex items-center justify-between px-3 py-2 rounded-lg bg-[#0f172a] border border-[#1e293b]">
                <div className="flex items-center gap-2 min-w-0">
                  <Laptop className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  {renamingId === d.id ? (
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => void submitRename(d.id)}
                      onKeyDown={(e) => e.key === 'Enter' && void submitRename(d.id)}
                      className="bg-[#0a0f18] border border-blue-500/50 rounded px-1.5 py-0.5 text-slate-200 text-xs w-40"
                    />
                  ) : (
                    <div className="min-w-0">
                      <div className="text-slate-300 truncate flex items-center gap-1">
                        {d.device_name}
                        {d.id === currentDeviceId && <span className="text-blue-400 text-[10px]">(this device)</span>}
                      </div>
                      <div className="text-[10px] text-slate-600">
                        {d.revoked_at ? 'Revoked' : d.last_seen_at ? `Last seen ${d.last_seen_at}` : 'Never used'}
                      </div>
                    </div>
                  )}
                </div>
                {!d.revoked_at && renamingId !== d.id && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => {
                        setRenamingId(d.id);
                        setRenameValue(d.device_name);
                      }}
                      className="text-slate-500 hover:text-slate-300"
                      title="Rename"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                    {d.id !== currentDeviceId && (
                      <button onClick={() => void revokeDevice(d.id)} className="text-red-400 hover:text-red-300">
                        Revoke
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {devices.some((d) => d.revoked_at) && (
            <button
              onClick={() => setShowRevoked((v) => !v)}
              className="mt-1.5 text-[10px] text-slate-600 hover:text-slate-400"
            >
              {showRevoked ? 'Hide' : 'Show'} revoked devices ({devices.filter((d) => d.revoked_at).length})
            </button>
          )}
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600 mb-2">Pair a new device</div>
          {!generatedCode ? (
            <button
              onClick={() => void handleGenerateCode()}
              disabled={generating}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold transition-colors"
            >
              {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
              Generate pairing code
            </button>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-950/80 border border-[#1e293b] w-fit">
              <span className="font-mono text-sm tracking-widest text-blue-300">{generatedCode}</span>
              <button onClick={copyCode} className="text-slate-400 hover:text-slate-200">
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}
          <p className="text-[10px] text-slate-600 mt-1.5">Enter this code on the new device. Expires in 10 minutes, single-use.</p>
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600 mb-2">Sync</div>
          <SyncSection />
        </div>

        {analyticsToggle}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 text-xs text-slate-400">
      <h3 className="text-sm font-bold text-slate-200 flex items-center gap-2">
        <UserCircle className="w-4 h-4 text-blue-400" />
        Account
      </h3>
      <p>Sign in to sync connections and settings across your devices.</p>

      {status === 'signing-in' ? (
        <div className="flex items-center gap-2">
          <button
            disabled
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 opacity-60 text-white text-sm font-semibold"
          >
            <Loader2 className="w-4 h-4 animate-spin" />
            Waiting for browser…
          </button>
          <button
            onClick={cancelLogin}
            className="px-3 py-2.5 rounded-xl bg-[#1e293b] hover:bg-[#263449] text-slate-300 text-sm font-semibold transition-colors shrink-0"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={() => void openLogin()}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold transition-colors"
        >
          <Globe className="w-4 h-4" />
          Sign in with browser
        </button>
      )}

      {error && (
        <div className="flex items-start gap-1.5 text-red-400">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 text-[10px] text-slate-600">
        <div className="flex-1 h-px bg-[#1e293b]" />
        or
        <div className="flex-1 h-px bg-[#1e293b]" />
      </div>

      <form onSubmit={handleRedeem} className="flex flex-col gap-2">
        <label className="text-slate-500">Enter a pairing code from another device</label>
        <div className="flex items-center gap-2">
          <input
            value={pairingInput}
            onChange={(e) => setPairingInput(e.target.value.toUpperCase())}
            placeholder="XXXXXXXX"
            maxLength={8}
            className="flex-1 bg-[#0f172a] border border-[#1e293b] rounded-lg px-3 py-2 text-slate-200 font-mono tracking-widest text-sm"
          />
          <button
            type="submit"
            disabled={pairingBusy || !pairingInput.trim()}
            className="px-3 py-2 rounded-lg bg-[#1e293b] hover:bg-[#263449] disabled:opacity-50 text-slate-200 font-semibold transition-colors shrink-0"
          >
            {pairingBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Pair'}
          </button>
        </div>
        {pairingError && (
          <div className="flex items-start gap-1.5 text-red-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {pairingError}
          </div>
        )}
      </form>

      {analyticsToggle}
    </div>
  );
};
