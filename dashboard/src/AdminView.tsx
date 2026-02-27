
import React, { useState, useEffect } from 'react';
import { Socket } from 'socket.io-client';
import { Users, Shield, Trash2, Globe, Search } from 'lucide-react';

export default function AdminView({ socket }: { socket: Socket | null }) {
    const [allProfiles, setAllProfiles] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState('');

    useEffect(() => {
        if (!socket) return;

        socket.emit('admin.getStats');
        socket.on('admin.statsUpdate', (data) => {
            setAllProfiles(data);
            setLoading(false);
        });

        return () => {
            socket.off('admin.statsUpdate');
        };
    }, [socket]);

    const handleAction = (type: string, profileId: string) => {
        if (confirm(`Are you sure you want to ${type} this profile?`)) {
            socket?.emit('admin.profileAction', { type, profileId });
        }
    };

    const filtered = allProfiles.filter(p =>
        p.name?.toLowerCase().includes(search.toLowerCase()) ||
        p.user_email?.toLowerCase().includes(search.toLowerCase())
    );

    return (
        <div className="flex-1 flex flex-col bg-[#fcfdfd] text-[#111b21] h-screen">
            <header className="h-[80px] bg-white px-10 flex items-center justify-between border-b border-[#eceff1] shadow-sm">
                <div className="flex items-center gap-5">
                    <div className="w-10 h-10 rounded-2xl bg-[#00a884]/10 flex items-center justify-center">
                        <Shield className="text-[#00a884] w-6 h-6" />
                    </div>
                    <div>
                        <h2 className="text-xl font-black tracking-tight">System Infrastructure</h2>
                        <p className="text-[10px] text-[#54656f] font-bold uppercase tracking-widest">Global Administration</p>
                    </div>
                </div>
                <div className="flex items-center bg-[#f8f9fa] rounded-2xl px-5 py-3 border border-[#eceff1] w-[450px] shadow-inner">
                    <Search className="w-4 h-4 text-[#aebac1] mr-3" />
                    <input
                        className="bg-transparent border-none outline-none text-sm w-full font-medium placeholder-[#aebac1]"
                        placeholder="Search users or profiles..."
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                    />
                </div>
            </header>

            <div className="p-10 overflow-y-auto custom-scrollbar">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10">
                    <div className="bg-white p-8 rounded-[32px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.03)]">
                        <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-3">Total Profiles</div>
                        <div className="text-3xl font-black text-[#111b21]">{allProfiles.length}</div>
                        <div className="text-[11px] text-[#aebac1] mt-2 font-medium">Provisioned in database</div>
                    </div>
                    <div className="bg-white p-8 rounded-[32px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.03)]">
                        <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-3">Active WABA Configs</div>
                        <div className="text-3xl font-black text-[#00a884]">
                            {allProfiles.filter(p => p.status === 'open').length}
                        </div>
                        <div className="text-[11px] text-[#00a884]/60 mt-2 font-bold flex items-center gap-1">
                            <div className="w-1.5 h-1.5 bg-[#00a884] rounded-full animate-pulse" />
                            Cloud API configured
                        </div>
                    </div>
                    <div className="bg-white p-8 rounded-[32px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.03)]">
                        <div className="text-[#54656f] text-[10px] uppercase font-black tracking-widest mb-3">Unique Entities</div>
                        <div className="text-3xl font-black text-[#111b21]">
                            {new Set(allProfiles.map(p => p.user_id)).size}
                        </div>
                        <div className="text-[11px] text-[#aebac1] mt-2 font-medium">Verified corporate identities</div>
                    </div>
                </div>

                <div className="bg-white rounded-[32px] border border-[#eceff1] shadow-[0_8px_30px_rgba(0,0,0,0.03)] overflow-hidden">
                    <table className="w-full text-left">
                        <thead className="bg-[#fcfdfd] text-[#54656f] text-[10px] uppercase font-black tracking-widest border-b border-[#eceff1]">
                            <tr>
                                <th className="px-8 py-5">System User</th>
                                <th className="px-8 py-5">Profile Alias</th>
                                <th className="px-8 py-5">Status</th>
                                <th className="px-8 py-5">Created</th>
                                <th className="px-8 py-5 text-right">Access Controls</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[#f0f2f5]">
                            {filtered.map((p) => (
                                <tr key={p.id} className="hover:bg-[#f8f9fa] transition-all group">
                                    <td className="px-8 py-6 text-sm">
                                        <div className="font-bold text-[#111b21]">{p.user_email || 'System Account'}</div>
                                        <div className="text-[9px] text-[#aebac1] font-mono mt-1">{p.user_id}</div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <div className="text-sm font-bold text-[#111b21]">{p.name}</div>
                                        <div className="text-[10px] text-[#aebac1] font-mono mt-1 opacity-0 group-hover:opacity-100 transition-opacity">{p.id}</div>
                                    </td>
                                    <td className="px-8 py-6">
                                        <span className={`px-3 py-1 rounded-full text-[9px] uppercase font-black tracking-widest border-2 ${p.status === 'open' ? 'bg-[#00a884]/5 text-[#00a884] border-[#00a884]/20' : 'bg-[#fcfdfd] text-[#aebac1] border-[#f0f2f5]'
                                            }`}>
                                            {p.status}
                                        </span>
                                    </td>
                                    <td className="px-8 py-6 text-[11px] text-[#54656f] font-bold">
                                        {new Date(p.created_at).toLocaleDateString()}
                                    </td>
                                    <td className="px-8 py-6 text-right">
                                        <div className="flex items-center justify-end gap-3">
                                            <button
                                                onClick={() => handleAction('delete', p.id)}
                                                className="w-9 h-9 flex items-center justify-center bg-white hover:bg-rose-500 text-rose-500 hover:text-white rounded-xl border border-rose-100 transition-all shadow-sm"
                                                title="Delete Profile"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
