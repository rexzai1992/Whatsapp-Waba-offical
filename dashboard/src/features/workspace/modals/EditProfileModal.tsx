import React from 'react';

type EditProfileModalProps = {
    open: boolean;
    profileName: string;
    onProfileNameChange: (value: string) => void;
    onClose: () => void;
    onSubmit: () => void;
};

export default function EditProfileModal({
    open,
    profileName,
    onProfileNameChange,
    onClose,
    onSubmit
}: EditProfileModalProps) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 bg-white/60 backdrop-blur-md flex items-center justify-center z-[200]">
            <div className="bg-white p-8 rounded-3xl w-full max-w-md shadow-[0_20px_60px_rgba(0,0,0,0.1)] border border-[#eceff1]">
                <h2 className="text-2xl font-bold mb-6 text-[#111b21]">Edit Profile Name</h2>
                <label className="block text-sm text-[#54656f] mb-2 font-medium">New Name</label>
                <input
                    type="text"
                    value={profileName}
                    onChange={(e) => onProfileNameChange(e.target.value)}
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
                    className="w-full bg-[#f8f9fa] border border-[#eceff1] rounded-xl px-4 py-4 mb-6 focus:border-[#00a884] outline-none text-[#111b21] font-medium"
                />
                <div className="flex justify-end gap-3">
                    <button
                        onClick={onClose}
                        className="px-6 py-3 text-[#54656f] font-bold hover:bg-[#f0f2f5] rounded-xl transition-all"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onSubmit}
                        className="bg-[#00a884] text-white px-8 py-3 rounded-xl font-bold shadow-[0_4px_12px_rgba(0,168,132,0.2)] hover:shadow-[0_8px_20px_rgba(0,168,132,0.3)] transition-all"
                    >
                        Save Changes
                    </button>
                </div>
            </div>
        </div>
    );
}
