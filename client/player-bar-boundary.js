/**
 * 播放条的错误边界：组件内部崩了要显示错误，而不是整条播放条消失。
 * （上一版就是因为一个未定义变量，播放条直接不见了。）
 */
export function createPlayerBarBoundary({ React, reportDiagnostic }) {
  const h = React.createElement;

  return class BarBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { err: null };
    }

    static getDerivedStateFromError(err) {
      return { err };
    }

    componentDidCatch(err) {
      reportDiagnostic('bar-crash', { err: String(err && err.message) });
    }

    render() {
      if (this.state.err) {
        return h(
          'div',
          {
            style: {
              flex: '0 0 100%',
              width: '100%',
              padding: '4px 8px',
              margin: '4px 0',
              font: '12px/1.5 system-ui, sans-serif',
              color: 'var(--dsw-alias-state-error-primary, #c62828)',
              border: '1px solid var(--dsw-alias-state-error-primary, #c62828)',
              borderRadius: 8,
            },
          },
          `播放条出错：${this.state.err.message}（右键时间位置可反馈给开发者）`,
        );
      }
      return this.props.children;
    }
  };
}
