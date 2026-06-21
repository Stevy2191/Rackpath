import { useEffect, useState } from 'react';

// True while the content element's rendered height exceeds the scrollable
// container's visible height and it isn't scrolled all the way to the
// bottom yet.
//
// Takes callback refs (not useRef) on purpose: this component renders
// `null` for a tick between a new slot being selected and its fields
// loading, so the container/content DOM nodes don't exist yet on the same
// render where a plain ref would be read. A callback ref re-fires (and
// updates this state) exactly when the node actually mounts, instead of
// relying on a dependency array to land on the right render by luck.
//
// A ResizeObserver on the *content* element (rather than the container,
// whose own box is fixed by its flex parent) is what catches height
// changes coming from descendants with their own local state — e.g. an
// accordion expanding — which don't re-render this component and so
// wouldn't otherwise be noticed.
export function useScrollOverflow() {
  const [container, setContainer] = useState(null);
  const [content, setContent] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!container || !content) return;

    const recompute = () => {
      setHasMore(container.scrollHeight - container.scrollTop - container.clientHeight > 4);
    };

    recompute();
    container.addEventListener('scroll', recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(content);
    ro.observe(container);

    return () => {
      container.removeEventListener('scroll', recompute);
      ro.disconnect();
    };
  }, [container, content]);

  return [setContainer, setContent, hasMore];
}
