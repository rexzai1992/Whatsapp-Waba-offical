import { useCallback, useLayoutEffect, useState } from 'react';

export const useElementSize = <T extends HTMLElement>() => {
    const [node, setNode] = useState<T | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const ref = useCallback((el: T | null) => {
        setNode(el);
    }, []);

    useLayoutEffect(() => {
        if (!node) return;

        const update = () => {
            setSize({
                width: node.clientWidth,
                height: node.clientHeight
            });
        };

        update();

        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', update);
            return () => window.removeEventListener('resize', update);
        }

        const observer = new ResizeObserver(() => update());
        observer.observe(node);
        return () => observer.disconnect();
    }, [node]);

    return { ref, size };
};
