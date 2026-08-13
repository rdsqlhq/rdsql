import React from 'react';
import { AlertTriangle, RefreshCw, Copy, Check } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last-resort catch-all for uncaught render errors. Without this, ANY
 * exception thrown while rendering (e.g. Monaco choking on a pathological
 * SQL buffer) unmounts the entire React tree with nothing to show in its
 * place — the whole app goes blank, and the only way out is a hard restart
 * that loses whatever the user was doing in every other tab too.
 *
 * This renders one level below the app root, so a crash anywhere still
 * leaves a recoverable screen instead of nothing.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Uncaught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return <ErrorFallback error={this.state.error} onReset={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

const ErrorFallback: React.FC<{ error: Error; onReset: () => void }> = ({ error, onReset }) => {
  const [copied, setCopied] = React.useState(false);
  const detail = `${error.name}: ${error.message}\n${error.stack ?? ''}`;

  return (
    <div className="fixed inset-0 z-[200] bg-[#06090e] flex items-center justify-center p-6">
      <div className="w-full max-w-lg bg-[#0a0f18] border border-[#1e293b] rounded-xl shadow-2xl p-5 text-slate-200">
        <div className="flex items-center gap-2 text-rose-400 mb-2">
          <AlertTriangle className="w-5 h-5" />
          <h2 className="text-sm font-bold">Something went wrong</h2>
        </div>
        <p className="text-xs text-slate-400 mb-3">
          A part of the app hit an unexpected error and couldn't render. Your connections and settings are
          unaffected — try continuing, or reload if the screen stays blank.
        </p>
        <pre className="text-[10.5px] font-mono text-slate-500 bg-[#06090e] border border-[#1e293b] rounded-lg p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all mb-3">
          {detail}
        </pre>
        <div className="flex items-center gap-2">
          <button
            onClick={onReset}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors"
          >
            Try to continue
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#263447] text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Reload App
          </button>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(detail).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            className="px-3 py-1.5 rounded-lg bg-[#1e293b] hover:bg-[#263447] text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition-colors ml-auto"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy error'}
          </button>
        </div>
      </div>
    </div>
  );
};
