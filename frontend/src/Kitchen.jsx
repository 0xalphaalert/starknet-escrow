import { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';
import { 
  CheckCircle, Clock, Receipt, Star, Wallet, TrendingUp, Award, ExternalLink
} from 'lucide-react';
import { uint256 } from "starknet";

// Web3 Block Confirmation Simulator
const BlockConfirmations = ({ hash, closedAt }) => {
  const [confs, setConfs] = useState(0);
  const TARGET = 32;

  useEffect(() => {
    if (!closedAt || !hash) return;
    
    const calculateBlocks = () => {
      // Calculate seconds since the transaction was saved to the database
      const secondsPassed = (Date.now() - new Date(closedAt).getTime()) / 1000;
      // Assume 1 Starknet block roughly every 3 seconds
      const simulatedBlocks = Math.floor(secondsPassed / 3);
      setConfs(Math.min(simulatedBlocks, TARGET));
    };

    calculateBlocks();
    const interval = setInterval(calculateBlocks, 3000);
    return () => clearInterval(interval);
  }, [closedAt, hash]);

  if (!hash) return <span className="text-gray-400 text-xs font-bold">No Hash</span>;

  const isComplete = confs >= TARGET;

  return (
    <div className="flex flex-col gap-1.5">
      <a 
        href={`https://sepolia.starkscan.co/tx/${hash}`} 
        target="_blank" 
        rel="noreferrer" 
        className="text-violet-600 font-black text-xs hover:text-violet-800 transition-colors flex items-center gap-1 bg-violet-50 px-2 py-1 rounded-md w-fit"
      >
        {hash.slice(0, 6)}...{hash.slice(-4)} <ExternalLink size={10} />
      </a>
      <div className={`text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 ${isComplete ? 'text-green-600' : 'text-amber-500'}`}>
        {!isComplete ? (
          <span className="w-2.5 h-2.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin"></span>
        ) : (
          <CheckCircle size={12} />
        )}
        {confs}/{TARGET} Blocks
      </div>
    </div>
  );
};
export default function Kitchen() {
  const [orders, setOrders] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [activeTab, setActiveTab] = useState('orders'); // 'orders', 'ratings', 'earnings'

  useEffect(() => {
    // Fetch the initial data exactly ONCE when the dashboard opens
    fetchInitialData();

    const channel = supabase
      .channel('schema-db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
        // 🔥 THE FIX: Surgically update the React state instead of re-downloading the whole database!
        if (payload.eventType === 'INSERT') {
          setOrders(prev => [payload.new, ...prev]);
        } else if (payload.eventType === 'UPDATE') {
          setOrders(prev => prev.map(o => o.id === payload.new.id ? payload.new : o));
        } else if (payload.eventType === 'DELETE') {
          setOrders(prev => prev.filter(o => o.id !== payload.old.id));
        }
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  const fetchInitialData = async () => {
    // 1. Fetch initial orders (Added a limit of 150 so it never crashes even if you have thousands of test orders)
    const { data: orderData } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(150); 
      
    if (orderData) setOrders(orderData);

    // 2. Fetch staff exactly ONCE (Staff don't change by the second)
    const { data: staffData } = await supabase
      .from('staff')
      .select('*')
      .eq('active', true);
      
    if (staffData) setStaffList(staffData);
  };

  const updateStatus = async (id, newStatus) => {
    await supabase.from('orders').update({ status: newStatus }).eq('id', id);
  };
  const handleForceSettle = async (orderToSettle) => {
    try {
      const btn = document.getElementById(`settle-btn-${orderToSettle.id}`);
      if (btn) btn.innerText = "Settling...";

      // 1. Connect the Restaurant/Staff Wallet
      const starknet = window.starknet;
      if (!starknet) throw new Error("Argent X not found");
      await starknet.enable();
      const account = starknet.account;

      // 2. Math for 5-Star Default (100% of staff maximums)
      const totalMicroUSDC = BigInt(Math.round(orderToSettle.total_amount * 1_000_000));
      let totalStaffEarned = 0n;
      
      const addresses = [];
      const amountsCalldata = [];
      const ROLE_SPLIT = { 'Chef': 22n, 'Customer Service / Quality': 22n, 'Service Crew': 15n, 'Housekeeping': 11n };

      // Automatically give everyone 5 stars
      staffList.forEach(staff => {
        const rolePercent = ROLE_SPLIT[staff.role];
        if (!rolePercent) return;

        const maxShare = (totalMicroUSDC * rolePercent) / 100n;
        const earnedShare = maxShare; // 5/5 stars = full maximum share

        totalStaffEarned += earnedShare;
        addresses.push(staff.wallet_address);

        const amountU256 = uint256.bnToUint256(earnedShare);
        amountsCalldata.push(amountU256.low, amountU256.high);
      });

      // 3. Restaurant gets the remaining 30%
      const RESTAURANT_WALLET = "0x0066730A1ad22Ac3e108C6D67ed585A016456B04d2d631aee5489CD9504e79fE";
      const restaurantPayout = totalMicroUSDC - totalStaffEarned;
      
      addresses.push(RESTAURANT_WALLET);
      const restU256 = uint256.bnToUint256(restaurantPayout);
      amountsCalldata.push(restU256.low, restU256.high);

      // 4. Trigger the Smart Contract Failsafe
      const ESCROW_ADDRESS = "0x04296b0eb46dd67dd478b72df88e7140ba7e0da3f43dcfd5eac092601c034b0a";
      const safeCalldata = [
        orderToSettle.on_chain_id.toString(), 
        addresses.length.toString(), 
        ...addresses.map(addr => addr.toString()),            
        addresses.length.toString(), 
        ...amountsCalldata.map(amt => amt.toString())       
      ];

      const releaseCall = {
        contractAddress: ESCROW_ADDRESS, 
        entrypoint: "release_to_payroll",
        calldata: safeCalldata
      };

      const tx = await account.execute([releaseCall]);
      console.log("🔥 FORCE SETTLED 🔥 Hash:", tx.transaction_hash);

      // 5. Update Supabase to close the order
      await supabase.from('orders').update({ 
        status: 'closed', 
        settlement_tx_hash: tx.transaction_hash 
      }).eq('id', orderToSettle.id);

      alert("Order Force Settled with 5-Star Ratings!");

    } catch (err) {
      console.error("Crash during force settle:", err);
      alert("Something went wrong: " + err.message);
      const btn = document.getElementById(`settle-btn-${orderToSettle.id}`);
      if (btn) btn.innerText = "Force Settle";
    }
  };

  // Sort active orders so oldest KOTs are at the top
  const pendingOrders = orders.filter(o => o.status === 'pending_kitchen').sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  const readyOrders = orders.filter(o => o.status === 'ready').sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
  
// Show orders that are picked up (completed) OR fully rated/paid out (closed)
const completedOrders = orders.filter(o => ['completed', 'closed'].includes(o.status));

  // --- CALCULATE LIVE DAILY EARNINGS ---
  const staffStats = {};
  staffList.forEach(s => {
    staffStats[s.role] = { ...s, totalEarned: 0 };
  });

  completedOrders.forEach(order => {
    if (!order.payouts?.payouts) return;
    Object.values(order.payouts.payouts).forEach(payout => {
       if (staffStats[payout.role]) {
          staffStats[payout.role].totalEarned += parseFloat(payout.usdc_earned);
       }
    });
  });

  // Helper function to grab specific role data for the table
  // Helper function to grab specific role data for the table
  const getRoleData = (order, roleName) => {
    // 1. If the customer already submitted ratings, use the real blockchain data!
    if (order.payouts?.payouts) {
      const payout = Object.values(order.payouts.payouts).find(p => p.role === roleName);
      if (!payout) return { stars: '-', earned: '0.00' };
      return { stars: payout.stars_received, earned: payout.usdc_earned };
    }

    // 2. IF NOT RATED YET: Calculate the 5-star default projection on the fly!
    const ROLE_SPLIT = { 'Chef': 0.22, 'Customer Service / Quality': 0.22, 'Service Crew': 0.15, 'Housekeeping': 0.11 };
    
    if (!ROLE_SPLIT[roleName]) return { stars: '-', earned: '0.00' };
    
    const expectedCut = parseFloat(order.total_amount) * ROLE_SPLIT[roleName];
    
    return { 
      stars: '5', // Default to 5 stars
      earned: expectedCut.toFixed(2) 
    };
  };

  return (
    <div className="min-h-screen bg-[#f4f5f7] font-sans text-gray-900 pb-10">
      
      {/* 📱 TOP NAVIGATION BAR */}
      <header className="bg-white shadow-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-violet-600 rounded-xl flex items-center justify-center text-white font-black text-xl">S</div>
            <h1 className="text-2xl font-black tracking-tight">StakServe <span className="text-violet-600 font-medium">KDS</span></h1>
          </div>

          <nav className="flex bg-gray-100 p-1 rounded-2xl">
            <button onClick={() => setActiveTab('orders')} className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-sm transition-all ${activeTab === 'orders' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-900'}`}><Receipt size={18} /> Live Orders</button>
            <button onClick={() => setActiveTab('ratings')} className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-sm transition-all ${activeTab === 'ratings' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-900'}`}><Star size={18} /> Customer Ratings</button>
            <button onClick={() => setActiveTab('earnings')} className={`flex items-center gap-2 px-6 py-2.5 rounded-xl font-bold text-sm transition-all ${activeTab === 'earnings' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-900'}`}><Wallet size={18} /> Earnings (USDC)</button>
          </nav>

          <div className="flex items-center gap-2 bg-green-50 text-green-700 px-4 py-2 rounded-full font-bold text-sm border border-green-200">
            <span className="w-2.5 h-2.5 bg-green-500 rounded-full animate-pulse"></span>
            System Live
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 pt-8">
        
        {/* 📋 TAB 1: LIVE ORDERS (KOT) */}
        {activeTab === 'orders' && (
          <div className="grid grid-cols-2 gap-8">
            {/* Preparing Column */}
            <div>
              <div className="flex items-center justify-between mb-4 px-2">
                <h2 className="text-lg font-black flex items-center gap-2 text-gray-800"><Clock className="text-violet-600" size={20} /> Preparing</h2>
                <span className="bg-gray-200 text-gray-700 px-3 py-1 rounded-full text-xs font-bold">{pendingOrders.length} Orders</span>
              </div>
              <div className="flex flex-col gap-4">
                {pendingOrders.length === 0 && <p className="text-gray-400 text-center py-10 font-medium">No active orders</p>}
                {pendingOrders.map(order => (
                  <div key={order.id} className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                    <div className="bg-gray-50 border-b border-gray-200 px-5 py-3 flex justify-between items-center">
                      <div>
                        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider block">Order ID</span>
                        <span className="text-lg font-black text-violet-700">#{order.id.split('-')[0].toUpperCase()}</span> 
                      </div>
                      <div className="text-right">
                        <span className="text-xs font-bold text-gray-400 uppercase tracking-wider block">Pickup Code</span>
                        <span className="text-lg font-black text-gray-900">{order.customer_wallet?.slice(0,4).toUpperCase() || 'PEND'}</span>
                      </div>
                    </div>
                    <div className="px-5 py-4">
                      <ul className="space-y-3">
                        {order.items.map((item, idx) => (
                          <li key={idx} className="flex items-start gap-3">
                            <span className="bg-gray-100 text-gray-800 font-black px-2 py-0.5 rounded text-sm">{item.qty}x</span>
                            <span className="font-bold text-gray-800">{item.name}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    <div className="px-5 pb-5">
                      <button onClick={() => updateStatus(order.id, 'ready')} className="w-full bg-violet-600 hover:bg-violet-700 text-white font-black py-3.5 rounded-xl transition-colors shadow-md shadow-violet-200">Mark as Ready</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Ready Column */}
            <div>
              <div className="flex items-center justify-between mb-4 px-2">
                <h2 className="text-lg font-black flex items-center gap-2 text-gray-800"><CheckCircle className="text-green-500" size={20} /> Ready for Pickup</h2>
                <span className="bg-gray-200 text-gray-700 px-3 py-1 rounded-full text-xs font-bold">{readyOrders.length} Orders</span>
              </div>
              <div className="flex flex-col gap-4">
                {readyOrders.length === 0 && <p className="text-gray-400 text-center py-10 font-medium">No orders waiting</p>}
                {readyOrders.map(order => (
                  <div key={order.id} className="bg-green-50 rounded-2xl border-2 border-green-400 p-5 flex items-center justify-between">
                    <div>
                      <span className="text-sm font-bold text-green-700 uppercase block mb-1">Pickup Code</span>
                      <span className="text-4xl font-black text-green-800">{order.customer_wallet?.slice(0,4).toUpperCase()}</span>
                    </div>
                    <button onClick={() => updateStatus(order.id, 'completed')} className="bg-green-500 hover:bg-green-600 text-white font-black px-8 py-4 rounded-xl transition-colors shadow-lg shadow-green-200">Complete Order</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ⭐ TAB 2: RATINGS & WEB3 PAYOUTS (Fully Dynamic) */}
        {activeTab === 'ratings' && (
          <div className="space-y-8">
            
            {/* TOP: Staff Daily Profiles */}
            <div className="bg-white rounded-3xl shadow-sm border border-gray-200 p-8">
              <div className="flex justify-between items-center mb-8 border-b border-gray-100 pb-6">
                <div>
                  <h2 className="text-2xl font-black text-gray-900">Live Team Earnings</h2>
                  <p className="text-gray-500 font-medium mt-1">Today's Web3 Smart Contract settlements.</p>
                </div>
                <Award size={48} className="text-amber-500 opacity-20" />
              </div>

              <div className="grid grid-cols-4 gap-6">
                {Object.values(staffStats)
                  .filter(staff => ['Chef', 'Housekeeping', 'Service Crew', 'Customer Service / Quality'].includes(staff.role))
                  .map((staff, i) => (
                  <div key={i} className="bg-gray-50 rounded-2xl p-5 border border-gray-100 flex flex-col items-center text-center">
                    <img src={staff.image_url} alt={staff.name} className="w-16 h-16 rounded-full object-cover mb-3 shadow-sm border-2 border-white" />
                    <h3 className="font-black text-gray-900 leading-tight">{staff.name}</h3>
                    <p className="text-[10px] font-black uppercase text-violet-600 tracking-wider mb-4">{staff.role}</p>
                    
                    <div className="bg-white w-full py-3 rounded-xl border border-gray-200">
                      <span className="text-xs font-bold text-gray-400 uppercase tracking-widest block mb-1">Total Earned</span>
                      <span className="font-black text-xl text-green-600">{staff.totalEarned.toFixed(2)} USDC</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* BOTTOM: Detailed Order History Table */}
            <div className="bg-white rounded-3xl shadow-sm border border-gray-200 overflow-hidden">
              <div className="p-6 border-b border-gray-100">
                <h2 className="text-xl font-black text-gray-900">Order & Tip History</h2>
              </div>
              
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="bg-gray-50 text-xs font-black text-gray-500 uppercase tracking-wider border-b border-gray-200">
                      <th className="p-4">Customer Name</th>
                      <th className="p-4 w-64">Items</th>
                      <th className="p-4">Total Paid</th>
                      <th className="p-4">Tx Status</th>
                      <th className="p-4 border-l border-gray-200 bg-amber-50/30 text-center">Chef</th>
                      <th className="p-4 border-l border-gray-200 bg-amber-50/30 text-center">Service Crew</th>
                      <th className="p-4 border-l border-gray-200 bg-amber-50/30 text-center">Housekeeping</th>
                      <th className="p-4 border-l border-gray-200 bg-amber-50/30 text-center">Quality</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {completedOrders.length === 0 && (
                      <tr><td colSpan="7" className="p-8 text-center text-gray-400 font-medium">No completed orders yet.</td></tr>
                    )}
                    {completedOrders.map(order => {
                      const chefData = getRoleData(order, 'Chef');
                      const serviceData = getRoleData(order, 'Service Crew');
                      const houseData = getRoleData(order, 'Housekeeping');
                      const qualityData = getRoleData(order, 'Customer Service / Quality');

                      return (
                        <tr key={order.id} className="hover:bg-gray-50 transition-colors">
                          <td className="p-4 font-bold text-gray-900 truncate max-w-[150px]">{order.customer_name}</td>
                          <td className="p-4 text-sm text-gray-600">
                            {order.items.map(item => `${item.qty}x ${item.name}`).join(', ')}
                          </td>
                          <td className="p-4 font-black text-violet-700">{order.total_amount.toFixed(2)} USDC</td>
                          {/* 🔥 UPDATED TO MATCH YOUR DATABASE COLUMN */}
  <td className="p-4">
    {order.status === 'completed' && !order.settlement_tx_hash ? (
      <button
        id={`settle-btn-${order.id}`}
        onClick={() => handleForceSettle(order)}
        className="bg-red-100 text-red-700 hover:bg-red-200 text-xs font-black uppercase tracking-wider px-3 py-2 rounded-lg transition-colors shadow-sm"
      >
        Force Settle
      </button>
    ) : (
      <BlockConfirmations 
        hash={order.settlement_tx_hash} 
        closedAt={order.created_at} 
      />
    )}
  </td>
                          
                          {/* Chef Column */}
                          <td className="p-4 border-l border-gray-100 text-center">
                            <div className="flex items-center justify-center gap-1 text-amber-500 font-black text-sm mb-1">
                               {chefData.stars} <Star size={12} className="fill-current" />
                            </div>
                            <span className="text-xs font-bold text-green-600">{chefData.earned} USDC</span>
                          </td>

                          {/* Service Crew Column */}
                          <td className="p-4 border-l border-gray-100 text-center">
                            <div className="flex items-center justify-center gap-1 text-amber-500 font-black text-sm mb-1">
                               {serviceData.stars} <Star size={12} className="fill-current" />
                            </div>
                            <span className="text-xs font-bold text-green-600">{serviceData.earned} USDC</span>
                          </td>

                          {/* Housekeeping Column */}
                          <td className="p-4 border-l border-gray-100 text-center">
                            <div className="flex items-center justify-center gap-1 text-amber-500 font-black text-sm mb-1">
                               {houseData.stars} <Star size={12} className="fill-current" />
                            </div>
                            <span className="text-xs font-bold text-green-600">{houseData.earned} USDC</span>
                          </td>

                          {/* Quality Column */}
                          <td className="p-4 border-l border-gray-100 text-center">
                            <div className="flex items-center justify-center gap-1 text-amber-500 font-black text-sm mb-1">
                               {qualityData.stars} <Star size={12} className="fill-current" />
                            </div>
                            <span className="text-xs font-bold text-green-600">{qualityData.earned} USDC</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        )}

        {/* 💰 TAB 3: EARNINGS (Company Treasury View) */}
        {activeTab === 'earnings' && (
          <div className="bg-white rounded-3xl shadow-sm border border-gray-200 p-8">
             <h2 className="text-2xl font-black text-gray-900 mb-6">Company Treasury View</h2>
             <p className="text-gray-500 mb-8">This tab shows the overall smart contract settlements, including the 30% base profit and recovered penalties.</p>
             {/* Note: I left the demo view here so you have something to show, but you can update this to read from `order.payouts.company_profit` if you want! */}
             <div className="bg-gradient-to-br from-violet-900 to-indigo-900 rounded-3xl p-8 text-white relative overflow-hidden shadow-2xl shadow-violet-200 max-w-md">
                <Wallet size={120} className="absolute -right-10 -bottom-10 opacity-10" />
                <p className="font-bold text-violet-300 uppercase tracking-widest text-sm mb-2">Available Treasury</p>
                <div className="text-5xl font-black mb-6">2,450.00 <span className="text-2xl text-violet-300">USDC</span></div>
             </div>
          </div>
        )}

      </main>
    </div>
  );
}