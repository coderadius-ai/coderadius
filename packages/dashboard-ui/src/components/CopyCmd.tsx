import { useState, useCallback } from 'react';
import { Copy, CheckCheck } from 'lucide-react';

/** A copyable shell command: mono text + click-to-copy. The honest affordance
 *  for a CLI-first product — never dress a "copy this command" up as a button
 *  that pretends to run an in-app action. */
export function CopyCmd({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        });
    }, [text]);
    return (
        <button className="cr-copy-cmd" onClick={handleCopy} title="Copy to clipboard">
            <code>{text}</code>
            {copied ? <CheckCheck size={12} /> : <Copy size={12} />}
        </button>
    );
}
