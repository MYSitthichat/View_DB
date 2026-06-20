import React from 'react';

// AppErrorBoundary prevents a render crash inside any subtree from killing
// the entire UI. Shows a friendly message with a "Reset" button that clears
// the error and tries again.
export class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('App crashed:', error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, color: '#fda4af', fontFamily: 'var(--font-mono)' }}>
        <h2 style={{ margin: '0 0 12px', color: 'var(--accent-rose)' }}>Something went wrong</h2>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.85rem' }}>
          {String(this.state.error?.message || this.state.error)}
        </pre>
        <button className="primary-btn" style={{ marginTop: 16 }} onClick={this.reset}>
          Reset
        </button>
      </div>
    );
  }
}
