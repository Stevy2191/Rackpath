import React from 'react';
import './ErrorBoundary.css';

// Class component because error boundaries must use the lifecycle hooks
// getDerivedStateFromError / componentDidCatch. Catches render-time errors in
// the subtree and shows a fallback instead of unmounting the whole app (which
// would blank the screen, including the navbar).
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught an error:', error, info);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h2>Something went wrong</h2>
          <p>{this.props.label || 'This section ran into an unexpected error.'}</p>
          <pre className="error-boundary-detail">{String(this.state.error?.message || this.state.error)}</pre>
          <button type="button" onClick={this.handleReset}>
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
