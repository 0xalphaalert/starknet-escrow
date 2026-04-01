import { useState, useEffect } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { supabase } from './supabaseClient';
import { RpcProvider, Contract, uint256, validateAndParseAddress, cairo } from "starknet";
// connect() removed — using window.starknet directly
import {
  Search, Heart, ShoppingBag, Minus, Plus, X, ChevronRight, MapPin, Star, Clock, CheckCircle, Receipt
} from 'lucide-react';
import { StarkZap, OnboardStrategy } from "starkzap";

const CATEGORIES = [
  { id: 'burger', label: 'Burgers', icon: '🍔' },
  { id: 'drink',  label: 'Drinks',  icon: '🥤' },
];

const TAG_STYLES = {
  "Chef's Pick": 'bg-amber-100 text-amber-700',
  'Spicy':       'bg-red-100 text-red-600',
  'Best Seller': 'bg-violet-100 text-violet-700',
  'Vegan':       'bg-green-100 text-green-700',
  'Refreshing':  'bg-sky-100 text-sky-700',
  'New':         'bg-pink-100 text-pink-600',
  'Classic':     'bg-blue-100 text-blue-700',
};
const ESCROW_ADDRESS = "0x04296b0eb46dd67dd478b72df88e7140ba7e0da3f43dcfd5eac092601c034b0a";

function tagStyle(tag) {
  return TAG_STYLES[tag] ?? 'bg-gray-100 text-gray-600';
}

// Helper component for the visual countdown
const CookingTimer = () => {
  const [timeLeft, setTimeLeft] = useState(15 * 60); 

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(prev => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const minutes = Math.floor(timeLeft / 60).toString().padStart(2, '0');
  const seconds = (timeLeft % 60).toString().padStart(2, '0');

  return <div className="text-4xl font-black text-gray-900 tracking-widest">{minutes}:{seconds}</div>;
};

export default function Menu() {
  const { user, authenticated, ready } = usePrivy();
  const [menuItems, setMenuItems] = useState([]);
  const [staffList, setStaffList] = useState([]);
  const [loading, setLoading] = useState(true);
  
  const [activeCategory, setActiveCategory] = useState('burger');
  const [selectedItem, setSelectedItem]     = useState(null);
  const [qty, setQty]                       = useState(1);
  const [cart, setCart]                     = useState([]);
  
  const [isProcessing, setIsProcessing]     = useState(false);
  const [isPaid, setIsPaid]                 = useState(false);
  const [currentOrder, setCurrentOrder]     = useState(null);
  const [ratings, setRatings]               = useState({});
  const [showCheckout, setShowCheckout]     = useState(false);
  const [paymentMethod, setPaymentMethod]   = useState('starkzap');

  // NEW: History States
  const [showHistory, setShowHistory]       = useState(false);
  const [orderHistory, setOrderHistory]     = useState([]);

  // 🔥 NEW: StarkZap Cartridge States
  const [starkzapWallet, setStarkzapWallet] = useState(null);


  // Fetch Data & Handle Auto-Resume
  useEffect(() => {
    async function fetchData() {
      // 1. Fetch Menu
      const { data: menuData } = await supabase.from('menu_items').select('*');
      if (menuData) setMenuItems(menuData);

      // 2. Fetch Active Staff
      const { data: staffData } = await supabase.from('staff').select('*').eq('active', true);
      if (staffData) setStaffList(staffData);

      // 3. Fetch User's Order History
      const customerName = user?.google?.name || user?.email?.address || 'Guest';
      const { data: historyData } = await supabase
        .from('orders')
        .select('*')
        .eq('customer_name', customerName)
        .order('created_at', { ascending: false });

      if (historyData && historyData.length > 0) {
        setOrderHistory(historyData);
        
        // AUTO-RESUME LOGIC: If their last order is still cooking or ready, pull it back up!
        const latestOrder = historyData[0];
        if (['pending_kitchen', 'ready'].includes(latestOrder.status)) {
          setCurrentOrder(latestOrder);
          setIsPaid(true);
          
          // Re-subscribe to real-time updates for this recovered order
          supabase.channel(`order-${latestOrder.id}`)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${latestOrder.id}` }, (payload) => {
              setCurrentOrder(payload.new);
            }).subscribe();
        }
      }

      setLoading(false);
    }
    
    // Run fetch once user loads or immediately if guest
    fetchData();
  }, [user]);

  const visibleItems = menuItems.filter((i) => i.category === activeCategory);
  const cartCount = cart.reduce((s, i) => s + i.qty, 0);
  const cartTotal = cart.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2);
  
  const getFeeMultiplier = () => {
    if (paymentMethod === 'copperx') return 0.04; 
    if (paymentMethod === 'zklend') return 0.01;  
    return 0; 
  };
  const feeAmount = (parseFloat(cartTotal) * getFeeMultiplier()).toFixed(2);
  const finalTotal = (parseFloat(cartTotal) + parseFloat(feeAmount)).toFixed(2);

  const handleAddToCart = () => {
    setCart((prev) => {
      const existing = prev.find((c) => c.id === selectedItem.id);
      if (existing) return prev.map((c) => c.id === selectedItem.id ? { ...c, qty: c.qty + qty } : c);
      return [...prev, { ...selectedItem, qty }];
    });
    setSelectedItem(null);
  };

  const calculateWeb3Payouts = (orderTotal, currentRatings, staffList) => {
    const totalPool = parseFloat(orderTotal); 
    const ROLE_SPLIT = { 'Chef': 0.22, 'Customer Service / Quality': 0.22, 'Service Crew': 0.15, 'Housekeeping': 0.11 };
    const BACK_HOUSE_BASE = 0.30;         

    const walletPayouts = {};
    let totalDistributedToStaff = 0;

    staffList.forEach(staff => {
      if (!ROLE_SPLIT[staff.role]) return;
      const maxShare = totalPool * ROLE_SPLIT[staff.role];
      const stars = currentRatings[staff.id] || 5; 
      const performanceMultiplier = stars / 5; 
      const exactCut = maxShare * performanceMultiplier;
      const earnedCutRounded = parseFloat(exactCut.toFixed(2));

      walletPayouts[staff.wallet_address] = {
        name: staff.name, role: staff.role, stars_received: stars,
        max_potential: maxShare.toFixed(2), usdc_earned: earnedCutRounded.toFixed(2)
      };
      totalDistributedToStaff += earnedCutRounded;
    });

    const baseCompanyProfit = totalPool * BACK_HOUSE_BASE;
    const staffMaxPotential = totalPool * 0.70; 
    const staffPenalties = staffMaxPotential - totalDistributedToStaff; 
    const finalCompanyProfit = parseFloat((baseCompanyProfit + staffPenalties).toFixed(2));

    return { 
      total_pool: totalPool.toFixed(2), distributed_to_staff: parseFloat(totalDistributedToStaff.toFixed(2)), 
      company_profit: finalCompanyProfit, payouts: walletPayouts 
    };
  };
  // 🔥 NEW: Helper to send the welcome email via Supabase Edge Functions
  const sendWalletDetailsEmail = async (userEmail, walletAddress) => {
    try {
      console.log(`Sending Welcome Email to ${userEmail} for wallet ${walletAddress}...`);
      
      await supabase.functions.invoke('send-welcome-email', {
        body: { email: userEmail, wallet: walletAddress }
      });
      
      console.log("Welcome email triggered successfully!");
    } catch (error) {
      console.error("Failed to trigger welcome email:", error);
    }
  };

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setIsProcessing(true);

    try {
      const USDC_ADDRESS = "0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343";
      const RESTAURANT_WALLET = validateAndParseAddress("0x0066730A1ad22Ac3e108C6D67ed585A016456B04d2d631aee5489CD9504e79fE");

      const amountInMicroUSDC = BigInt(Math.round(parseFloat(finalTotal) * 1_000_000));
      const amountUint256 = uint256.bnToUint256(amountInMicroUSDC);
      const onChainOrderId = Math.floor(Date.now() / 1000);

      let pickupCode = Math.random().toString(36).slice(2, 6).toUpperCase();

      if (paymentMethod === 'starkzap') {
        let activeWallet = starkzapWallet;
        if (!activeWallet) {
          const sdk = new StarkZap({ network: "sepolia" });
          
          const sessionPolicies = [
            { target: USDC_ADDRESS, method: "approve" },
            { target: ESCROW_ADDRESS, method: "deposit" }
          ];

          const { wallet } = await sdk.onboard({ 
            strategy: OnboardStrategy.Cartridge,
            options: { policies: sessionPolicies }
          });
          
          activeWallet = wallet;
          setStarkzapWallet(wallet);

          // 🔥 NEW: Trigger the email silently in the background on first creation!
          const userEmail = user?.email?.address || user?.google?.email;
          if (userEmail && wallet?.account?.address) {
             sendWalletDetailsEmail(userEmail, wallet.account.address);
          }
        }

        console.log(`[StarkZap] Executing background payment via Cartridge...`);

        // 🔥 THE SILENT MULTI-CALL: Groups Approve + Deposit into ONE background call
        const tx = await activeWallet.execute([
          {
            contractAddress: USDC_ADDRESS,
            entrypoint: "approve",
            calldata: [ESCROW_ADDRESS, amountUint256.low.toString(), amountUint256.high.toString()]
          },
          {
            contractAddress: ESCROW_ADDRESS,
            entrypoint: "deposit",
            calldata: [onChainOrderId.toString(), amountUint256.low.toString(), amountUint256.high.toString()]
          }
        ]);

        console.log("✅ Silent Transaction Confirmed:", tx.transaction_hash);
        
        // Set the pickup code to the first 4 characters of the session wallet address
        pickupCode = activeWallet.account?.address?.slice(2, 6).toUpperCase() || pickupCode;
      

      } else if (paymentMethod === 'copperx') {
        console.log(`[CopperX] Fiat on-ramp — simulated for demo`);
        await new Promise(resolve => setTimeout(resolve, 3000));

      } else if (paymentMethod === 'zklend') {
        console.log(`[zkLend] Borrowing ${finalTotal} USDC via zkLend Sepolia...`);
        
        // Fallback to standard Argent X popup for zkLend
        const starknet = window.starknet;
        if (!starknet) throw new Error("Argent X not found. Please install it.");
        await starknet.enable();
        const account = starknet.account;
        pickupCode = account.address ? account.address.slice(0, 4).toUpperCase() : pickupCode;

        const ZKLEND_MARKET = "0x04c0a5193d58f74fbace4b74dcf65481e734ed1714121bdc571da345540efa05";

        const approveCall = {
          contractAddress: USDC_ADDRESS,
          entrypoint: "approve",
          calldata: [ZKLEND_MARKET, amountUint256.low, amountUint256.high],
        };

        const borrowCall = {
          contractAddress: ZKLEND_MARKET,
          entrypoint: "borrow",
          calldata: [USDC_ADDRESS, amountUint256.low, amountUint256.high],
        };

        const transferCall = {
          contractAddress: USDC_ADDRESS,
          entrypoint: "transfer",
          calldata: [RESTAURANT_WALLET, amountUint256.low, amountUint256.high],
        };

        const tx = await account.execute([approveCall, borrowCall, transferCall]);
        console.log("✅ zkLend + Transfer confirmed:", tx.transaction_hash);
      }

      // STEP D: Save confirmed order to Supabase
      const customerName = user?.google?.name || user?.email?.address || 'Guest';

      const { data, error } = await supabase.from('orders').insert([{
        table_number: 0,
        items: cart,
        total_amount: parseFloat(finalTotal),
        payment_method: paymentMethod,
        status: 'pending_kitchen',
        customer_name: customerName,
        customer_wallet: pickupCode,
        on_chain_id: onChainOrderId
      }]).select().single();

      if (!error) {
        setCurrentOrder(data);
        setShowCheckout(false);
        setIsPaid(true);

        supabase.channel(`order-${data.id}`)
          .on('postgres_changes', {
            event: 'UPDATE', schema: 'public',
            table: 'orders', filter: `id=eq.${data.id}`
          }, (payload) => { setCurrentOrder(payload.new); })
          .subscribe();
      } else {
        console.error("Supabase Order Failed", error);
      }

    } catch (error) {
      console.error("Transaction Failed:", error);
      alert("Payment failed or was rejected. Error: " + error.message);
    } finally {
      setIsProcessing(false);
    }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center font-bold text-violet-600">Loading StakServe...</div>;

  // --- ACTIVE ORDER SCREENS ---
  if (isPaid && currentOrder) {
    if (currentOrder.status === 'pending_kitchen') {
      const chef = staffList.find(s => s.role === 'Chef') || { name: 'Chef Marcus', image_url: 'https://images.unsplash.com/photo-1577219491135-ce391730fb2c?w=400&auto=format&fit=crop' };

      return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center pt-10 px-6 pb-20 font-sans">
          <div className="w-full max-w-md flex justify-between items-center mb-8">
            <h1 className="text-2xl font-black text-gray-900 tracking-tight">Order Status</h1>
            <span className="bg-green-100 text-green-700 px-3 py-1.5 rounded-full text-xs font-black uppercase tracking-wider flex items-center gap-1 shadow-sm"><CheckCircle size={14} strokeWidth={3} /> Paid</span>
          </div>
          <div className="bg-white p-1 rounded-3xl shadow-xl shadow-gray-200/50 w-full max-w-md relative overflow-hidden">
             <div className="bg-white rounded-[1.4rem] p-6 border border-gray-100">
               <div className="text-center mb-8 mt-2">
                 <p className="text-gray-400 text-xs font-black uppercase tracking-[0.2em] mb-2">Order Number</p>
                 <h2 className="text-5xl font-black text-violet-600 mb-3">#{currentOrder.id.split('-')[0].toUpperCase()}</h2>
                 <div className="inline-block bg-gray-50 px-4 py-2 rounded-xl border border-gray-100">
                    <p className="text-gray-900 font-black text-lg">{currentOrder.total_amount.toFixed(2)} USDC</p>
                 </div>
               </div>
               <div className="bg-gray-50 rounded-2xl p-6 text-center mb-8 border border-gray-100 relative overflow-hidden">
                 <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-orange-400 to-amber-400"></div>
                 <p className="text-gray-500 text-xs font-black uppercase tracking-widest mb-3 flex items-center justify-center gap-2"><Clock size={16} className="text-orange-500" /> Estimated Time</p>
                 <CookingTimer />
                 <p className="text-orange-600 font-bold text-sm mt-3 animate-pulse bg-orange-100 inline-block px-3 py-1 rounded-full">Chef is preparing your food...</p>
               </div>
               <div className="flex items-center gap-4 bg-violet-50 p-4 rounded-2xl border border-violet-100">
                 <div className="relative">
                   <img src={chef.image_url} alt={chef.name} className="w-14 h-14 rounded-full object-cover border-2 border-white shadow-md" />
                   <span className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-green-500 border-2 border-white rounded-full"></span>
                 </div>
                 <div>
                   <p className="text-[10px] font-black text-violet-600 uppercase tracking-widest mb-0.5">Assigned Chef</p>
                   <p className="font-black text-gray-900 text-lg leading-tight">{chef.name}</p>
                 </div>
               </div>
             </div>
          </div>
        </div>
      );
    }

    if (currentOrder.status === 'ready') {
      return (
        <div className="min-h-screen bg-violet-600 flex flex-col items-center justify-center px-10 text-center text-white">
          <div className="w-32 h-32 bg-white rounded-full flex items-center justify-center text-6xl mb-6 shadow-2xl">🍔</div>
          <h1 className="text-4xl font-black mb-2 animate-bounce">Food is Ready!</h1>
          <p className="text-violet-200 mb-8 font-medium text-lg">Please proceed to the counter</p>
          <div className="bg-white text-violet-900 p-8 rounded-3xl w-full shadow-2xl mb-6">
            <p className="text-sm uppercase tracking-widest font-bold mb-2 opacity-50">Your Pickup Code</p>
            <span className="text-6xl font-black">{currentOrder.customer_wallet}</span>
          </div>
        </div>
      );
    }

    if (currentOrder.status === 'completed') {
      const handleRating = (staffId, starValue) => { setRatings(prev => ({ ...prev, [staffId]: starValue })); };
      return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center px-6 py-10 font-sans">
          <div className="bg-white p-6 rounded-3xl shadow-xl w-full max-w-md border border-gray-100">
            <div className="text-center mb-6">
              <span className="text-5xl mb-4 block">⭐</span>
              <h2 className="text-2xl font-black text-gray-900">How was your meal?</h2>
              <p className="text-gray-500 text-sm mt-2">Your feedback helps us maintain the highest standards of service and quality.</p>
            </div>
            <div className="space-y-3 mb-8">
              {staffList.map(staff => {
                const currentRating = ratings[staff.id] || 0; 
                return (
                  <div key={staff.id} className="flex justify-between items-center bg-gray-50 p-3 rounded-2xl border border-gray-100">
                    <div className="flex items-center gap-3">
                      <img src={staff.image_url} alt={staff.name} className="w-12 h-12 rounded-full object-cover border-2 border-white shadow-sm" />
                      <div>
                        <span className="font-bold text-gray-900 block leading-tight">{staff.name}</span>
                        <span className="text-[10px] font-black uppercase text-violet-600 tracking-wider">{staff.role}</span>
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {[1,2,3,4,5].map(star => (
                        <Star key={star} size={24} onClick={() => handleRating(staff.id, star)} className={`cursor-pointer transition-all ${star <= currentRating ? 'text-amber-400 fill-amber-400 scale-110' : 'text-gray-300 hover:text-amber-200'}`} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <button onClick={async () => { 
                const btn = document.getElementById('submit-btn');
                if(btn) btn.innerText = "Executing Smart Contract...";
                
                try {
                  // 1. Calculate the UI display payouts (Keep this to save to Supabase history!)
                  const payoutData = calculateWeb3Payouts(currentOrder.total_amount, ratings, staffList);
                  
                  // 2. WAKE UP THE WALLET
                  const starknet = window.starknet;
                  if (!starknet) throw new Error("Argent X not found");
                  await starknet.enable();
                  const account = starknet.account;

                  // 3. ON-CHAIN MATH (Strict 6-decimal BigInt math to prevent rounding failures)
                  const totalMicroUSDC = BigInt(Math.round(currentOrder.total_amount * 1_000_000));
                  let totalStaffEarned = 0n;

                  const addresses = [];
                  const amountsCalldata = [];

                  const ROLE_SPLIT = { 'Chef': 22n, 'Customer Service / Quality': 22n, 'Service Crew': 15n, 'Housekeeping': 11n };

                  // Process Staff Payouts (70% Max Pool)
                  staffList.forEach(staff => {
                    const rolePercent = ROLE_SPLIT[staff.role];
                    if (!rolePercent) return;

                    // If 0 or no rating is given, default to 5 stars!
                    const stars = (ratings[staff.id] && ratings[staff.id] > 0) ? BigInt(ratings[staff.id]) : 5n;

                    const maxShare = (totalMicroUSDC * rolePercent) / 100n;
                    const earnedShare = (maxShare * stars) / 5n;

                    totalStaffEarned += earnedShare;
                    addresses.push(staff.wallet_address);

                    // Convert to u256 (low, high pairs)
                    const amountU256 = uint256.bnToUint256(earnedShare);
                    amountsCalldata.push(amountU256.low, amountU256.high);
                  });

                  // Process Restaurant Payout (30% Base + Penalties)
                  // CRITICAL: Subtracting staff total from the absolute total GUARANTEES sum(amounts) === deposited amount!
                  const RESTAURANT_WALLET = "0x0066730A1ad22Ac3e108C6D67ed585A016456B04d2d631aee5489CD9504e79fE";
                  const restaurantPayout = totalMicroUSDC - totalStaffEarned;

                  addresses.push(RESTAURANT_WALLET);
                  const restU256 = uint256.bnToUint256(restaurantPayout);
                  amountsCalldata.push(restU256.low, restU256.high);

                  // 4. TRIGGER THE ESCROW RELEASE
                  const safeCalldata = [
                    currentOrder.on_chain_id.toString(), // NEW: Tell contract WHICH box to unlock
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

                  // 4. TRIGGER THE ESCROW RELEASE
                  const tx = await account.execute([releaseCall]);
                  console.log("🔥 ESCROW RELEASED 🔥 Hash:", tx.transaction_hash);
                  
                  // 3. Save to Supabase using the REAL hash!
                  const { error } = await supabase.from('orders').update({ 
                    ratings: ratings, 
                    payouts: payoutData, 
                    status: 'closed', 
                    settlement_tx_hash: tx.transaction_hash // <-- REAL HASH HERE
                  }).eq('id', currentOrder.id);
                  
                  if (!error) {
                    alert("Thank you for your feedback! Smart Contract Executed."); 
                    window.location.reload(); 
                  } else {
                    console.error("Supabase Error:", error);
                    if(btn) btn.innerText = "Submit Ratings";
                  }
                } catch (err) {
                  // If anything breaks, un-freeze the button and show the error!
                  console.error("Crash during rating:", err);
                  alert("Something went wrong: " + err.message);
                  if(btn) btn.innerText = "Submit Ratings";
                }
              }}
              id="submit-btn" className="w-full bg-gray-900 hover:bg-black text-white font-black py-4 rounded-xl transition-colors shadow-lg mt-6"
            >
              Submit Ratings
            </button>
          </div>
        </div>
      );
    }
  }

  // --- ORDER HISTORY SCREEN ---
  if (showHistory) {
    return (
      <div className="min-h-screen bg-gray-50 max-w-md mx-auto relative pb-10 font-sans">
        {/* Header */}
        <div className="sticky top-0 z-40 bg-white border-b border-gray-100 px-5 py-4 flex justify-between items-center shadow-sm">
          <h1 className="text-xl font-black text-gray-900 tracking-tight">Your Receipts</h1>
          <button onClick={() => setShowHistory(false)} className="w-10 h-10 bg-gray-100 rounded-2xl flex items-center justify-center text-gray-600 hover:bg-gray-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 pt-6 space-y-4">
          {orderHistory.length === 0 ? (
            <div className="text-center py-20 text-gray-400 font-bold">No past orders found.</div>
          ) : (
            orderHistory.map(order => {
              // Set badge colors dynamically
              let badgeColor = "bg-green-100 text-green-700";
              let statusText = "Completed";
              if (order.status === 'pending_kitchen') { badgeColor = "bg-orange-100 text-orange-700 animate-pulse"; statusText = "Cooking"; }
              if (order.status === 'ready') { badgeColor = "bg-violet-100 text-violet-700"; statusText = "Ready for Pickup"; }

              return (
                <div key={order.id} className="bg-white p-5 rounded-3xl shadow-sm border border-gray-100">
                  <div className="flex justify-between items-start mb-4 border-b border-gray-50 pb-4">
                    <div>
                      <span className={`text-[10px] font-black uppercase tracking-widest px-2.5 py-1 rounded-md mb-2 inline-block ${badgeColor}`}>
                        {statusText}
                      </span>
                      <p className="text-xs text-gray-400 font-bold">
                        {new Date(order.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xl font-black text-gray-900">{order.total_amount.toFixed(2)} USDC</p>
                      <p className="text-[10px] text-gray-400 font-bold uppercase tracking-wider">{order.payment_method}</p>
                    </div>
                  </div>
                  
                  <ul className="space-y-2">
                    {order.items.map((item, idx) => (
                      <li key={idx} className="flex gap-3 text-sm font-bold text-gray-700">
                        <span className="text-gray-400">{item.qty}x</span> <span>{item.name}</span>
                      </li>
                    ))}
                  </ul>
                  
                  {/* If the order is active, give them a button to jump back in! */}
                  {['pending_kitchen', 'ready'].includes(order.status) && (
                    <button 
                      onClick={() => { setCurrentOrder(order); setIsPaid(true); setShowHistory(false); }}
                      className="w-full mt-4 bg-gray-900 text-white font-black py-3 rounded-xl text-sm hover:bg-black transition-colors"
                    >
                      View Live Status
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // --- MAIN MENU SCREEN ---
  return (
    <div className="min-h-screen bg-gray-50 max-w-md mx-auto relative pb-36">
      {/* Header with new History Button */}
      <div className="sticky top-0 z-40 bg-white/90 backdrop-blur-md border-b border-gray-100 px-5 py-4 flex justify-between items-center">
        <div>
          <span className="text-xl font-black tracking-tight text-gray-900">Stak<span className="text-violet-600">Serve</span></span>
          <div className="flex items-center gap-1 mt-0.5">
            <MapPin size={11} className="text-violet-500" />
            <span className="text-xs font-semibold text-gray-400 tracking-wide uppercase">Pickup Counter</span>
          </div>
        </div>
        <div className="flex gap-2">
          {/* HISTORY TOGGLE BUTTON */}
          <button onClick={() => setShowHistory(true)} className="w-10 h-10 bg-gray-100 rounded-2xl flex items-center justify-center text-gray-600 hover:bg-gray-200 transition-colors">
            <Receipt size={18} />
          </button>
          <div className="w-10 h-10 bg-gray-100 rounded-2xl flex items-center justify-center">
            <ShoppingBag size={18} className="text-gray-600" />
          </div>
        </div>
      </div>

      {/* Hero */}
      <div className="px-5 pt-5 pb-1">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-1">Good evening 👋</p>
        <h1 className="text-2xl font-black text-gray-900 leading-tight">What are you<br /><span className="text-violet-600">craving today?</span></h1>
      </div>

      {/* Category Slider */}
      <div className="flex gap-4 px-5 py-5 overflow-x-auto scrollbar-hide">
        {CATEGORIES.map(cat => (
          <button key={cat.id} onClick={() => setActiveCategory(cat.id)} className="flex flex-col items-center gap-2">
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center text-2xl transition-all ${activeCategory === cat.id ? 'bg-violet-600 shadow-md scale-105' : 'bg-gray-100'}`}>
              {cat.icon}
            </div>
            <span className={`text-xs font-semibold ${activeCategory === cat.id ? 'text-violet-700' : 'text-gray-500'}`}>{cat.label}</span>
          </button>
        ))}
      </div>

      {/* Food Grid */}
      <div className="grid grid-cols-2 gap-3 px-5">
        {visibleItems.map(item => (
          <button key={item.id} onClick={() => { setSelectedItem(item); setQty(1); }} className="bg-white rounded-3xl overflow-hidden shadow-sm border border-gray-100 text-left w-full relative">
            <img src={item.image_url} alt={item.name} className="w-full aspect-square object-cover" />
            {item.tag && <span className={`absolute top-3 left-3 text-[10px] font-bold px-2 py-1 rounded-full ${tagStyle(item.tag)}`}>{item.tag}</span>}
            <div className="p-3">
              <p className="font-bold text-sm text-gray-900 leading-tight truncate">{item.name}</p>
              <p className="text-sm font-black text-violet-700 mt-2">{item.price.toFixed(2)} USDC</p>
            </div>
          </button>
        ))}
      </div>

      {/* Bottom Sheet Modal */}
      {selectedItem && (
        <div className="fixed inset-0 z-50 flex items-end bg-black/50" onClick={() => setSelectedItem(null)}>
          <div className="w-full bg-white rounded-t-[2.5rem] overflow-hidden max-h-[85vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <img src={selectedItem.image_url} alt={selectedItem.name} className="w-full h-64 object-cover" />
            <div className="px-6 pt-6 pb-10">
              <h2 className="text-2xl font-black text-gray-900 mb-2">{selectedItem.name}</h2>
              <p className="text-gray-500 text-sm mb-6">{selectedItem.description}</p>
              
              <div className="flex justify-between items-center mb-6">
                <p className="text-2xl font-black text-violet-700">{(selectedItem.price * qty).toFixed(2)} USDC</p>
                <div className="flex items-center gap-4 bg-gray-100 rounded-2xl px-4 py-3">
                  <button onClick={() => setQty(Math.max(1, qty - 1))}><Minus size={14} /></button>
                  <span className="font-black text-lg">{qty}</span>
                  <button onClick={() => setQty(qty + 1)}><Plus size={14} /></button>
                </div>
              </div>
              <button onClick={handleAddToCart} className="w-full py-5 rounded-2xl font-black text-white bg-gradient-to-r from-violet-600 to-pink-600">
                Add to Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Floating Cart Footer */}
      {cart.length > 0 && !showCheckout && (
        <button onClick={() => setShowCheckout(true)} className="fixed bottom-5 left-5 right-5 z-40 flex items-center justify-between px-5 py-4 rounded-2xl text-white font-bold bg-gradient-to-r from-violet-600 to-pink-600 shadow-xl hover:scale-[1.02] transition-transform">
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 bg-white/20 rounded-xl flex items-center justify-center font-black text-sm">{cartCount}</span>
            <span className="text-base">Checkout</span>
          </div>
          <div className="flex items-center gap-1 font-black">
            <span>{cartTotal} USDC</span>
            <ChevronRight size={18} />
          </div>
        </button>
      )}

      {/* Checkout Payment Selector Modal */}
      {showCheckout && (
        <div className="fixed inset-0 z-50 flex items-end bg-gray-900/60 backdrop-blur-sm" onClick={() => !isProcessing && setShowCheckout(false)}>
          <div className="w-full bg-white rounded-t-[2.5rem] overflow-hidden p-6 pb-10 shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
            
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-2xl font-black text-gray-900">Payment</h2>
              <button onClick={() => setShowCheckout(false)} className="bg-gray-100 p-2 rounded-full text-gray-500"><X size={20} /></button>
            </div>

            {/* Order Summary */}
            <div className="bg-gray-50 rounded-2xl p-4 mb-6 border border-gray-100">
              <div className="flex justify-between text-sm font-bold text-gray-500 mb-2">
                <span>Subtotal</span>
                <span>{cartTotal} USDC</span>
              </div>
              <div className="flex justify-between text-sm font-bold text-gray-500 mb-4 pb-4 border-b border-gray-200">
                <span>Network / Processing Fee</span>
                <span className={feeAmount > 0 ? "text-red-500" : "text-green-500"}>
                  {feeAmount > 0 ? `+ ${feeAmount}` : "Free"}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="font-black text-gray-900 text-lg">Total to Pay</span>
                <span className="font-black text-violet-700 text-2xl">{finalTotal} USDC</span>
              </div>
            </div>

            <p className="text-xs font-black uppercase tracking-widest text-gray-400 mb-3">Select Method</p>
            
            <div className="space-y-3 mb-8">
              <button onClick={() => setPaymentMethod('starkzap')} className={`w-full flex items-center justify-between p-4 rounded-2xl border-2 transition-all ${paymentMethod === 'starkzap' ? 'border-violet-600 bg-violet-50' : 'border-gray-100 bg-white hover:border-gray-200'}`}>
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl ${paymentMethod === 'starkzap' ? 'bg-violet-600 text-white' : 'bg-gray-100'}`}>⚡</div>
                  <div className="text-left"><p className="font-black text-gray-900 leading-tight">Starkzap Crypto</p><p className="text-xs font-bold text-green-600">0% Gas Fees</p></div>
                </div>
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${paymentMethod === 'starkzap' ? 'border-violet-600' : 'border-gray-300'}`}>
                  {paymentMethod === 'starkzap' && <div className="w-2.5 h-2.5 bg-violet-600 rounded-full" />}
                </div>
              </button>

              <button onClick={() => setPaymentMethod('copperx')} className={`w-full flex items-center justify-between p-4 rounded-2xl border-2 transition-all ${paymentMethod === 'copperx' ? 'border-gray-900 bg-gray-50' : 'border-gray-100 bg-white hover:border-gray-200'}`}>
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl ${paymentMethod === 'copperx' ? 'bg-gray-900 text-white' : 'bg-gray-100'}`}>💳</div>
                  <div className="text-left"><p className="font-black text-gray-900 leading-tight">Card or UPI <span className="text-[10px] bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded ml-1">CopperX</span></p><p className="text-xs font-bold text-red-500">4% Processing Fee</p></div>
                </div>
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${paymentMethod === 'copperx' ? 'border-gray-900' : 'border-gray-300'}`}>
                  {paymentMethod === 'copperx' && <div className="w-2.5 h-2.5 bg-gray-900 rounded-full" />}
                </div>
              </button>

              <button onClick={() => setPaymentMethod('zklend')} className={`w-full flex items-center justify-between p-4 rounded-2xl border-2 transition-all ${paymentMethod === 'zklend' ? 'border-blue-600 bg-blue-50' : 'border-gray-100 bg-white hover:border-gray-200'}`}>
                <div className="flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl ${paymentMethod === 'zklend' ? 'bg-blue-600 text-white' : 'bg-gray-100'}`}>🏦</div>
                  <div className="text-left"><p className="font-black text-gray-900 leading-tight">Borrow & Pay</p><p className="text-xs font-bold text-blue-600">1% zkLend Protocol Fee</p></div>
                </div>
                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${paymentMethod === 'zklend' ? 'border-blue-600' : 'border-gray-300'}`}>
                  {paymentMethod === 'zklend' && <div className="w-2.5 h-2.5 bg-blue-600 rounded-full" />}
                </div>
              </button>
            </div>

            <button onClick={handleCheckout} disabled={isProcessing} className="w-full py-4 rounded-2xl font-black text-white bg-gray-900 hover:bg-black flex justify-center items-center gap-2 shadow-lg disabled:opacity-70">
              {isProcessing ? (
                <><span className="w-5 h-5 border-4 border-white/20 border-t-white rounded-full animate-spin"></span> Processing...</>
              ) : ( `Confirm & Pay ${finalTotal} USDC` )}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}