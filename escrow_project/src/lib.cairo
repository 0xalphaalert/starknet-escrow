#[starknet::interface]
trait IERC20<TState> {
    fn transfer(ref self: TState, recipient: starknet::ContractAddress, amount: u256) -> bool;
    fn transfer_from(ref self: TState, sender: starknet::ContractAddress, recipient: starknet::ContractAddress, amount: u256) -> bool;
}

#[starknet::contract]
mod Escrow {
    use super::IERC20Dispatcher;
    use super::IERC20DispatcherTrait;

    use starknet::{
        ContractAddress,
        get_caller_address,
        get_contract_address
    };

    use starknet::storage::{
        StoragePointerReadAccess,
        StoragePointerWriteAccess
    };

    #[storage]
    struct Storage {
        payer: ContractAddress,
        payee: ContractAddress,
        amount: u256,
        is_released: bool,
        usdc_address: ContractAddress,
    }

    #[constructor]
fn constructor(ref self: ContractState, usdc_token: ContractAddress) {
    self.usdc_address.write(usdc_token);
    self.is_released.write(true); // ✅ allow first deposit
}

    #[external(v0)]
    fn deposit(
        ref self: ContractState,
        payee: ContractAddress,
        amount: u256
    ) {
        let caller = get_caller_address();
        let this_contract = get_contract_address();

        // ✅ Prevent zero deposit
        assert(amount.low > 0 || amount.high > 0, 'Invalid amount');

        // ✅ Prevent overwriting active escrow
        assert(self.is_released.read(), 'Previous escrow not released');

        let usdc = IERC20Dispatcher {
            contract_address: self.usdc_address.read()
        };

        // 💰 Pull USDC into contract
        usdc.transfer_from(caller, this_contract, amount);

        self.payer.write(caller);
        self.payee.write(payee);
        self.amount.write(amount);
        self.is_released.write(false);
    }

    #[external(v0)]
    fn release_to_payroll(
        ref self: ContractState,
        staff_addresses: Span<ContractAddress>,
        amounts: Span<u256>
    ) {
        let caller = get_caller_address();

        // 🔐 Access control
        assert(caller == self.payer.read(), 'Only payer');

        // 🔁 Prevent double execution
        assert(!self.is_released.read(), 'Already released');

        // 📏 Validate arrays
        assert(staff_addresses.len() == amounts.len(), 'Length mismatch');

        let usdc = IERC20Dispatcher {
            contract_address: self.usdc_address.read()
        };

        // 🔢 Validate total distribution
        let mut total: u256 = 0;
        let mut i: usize = 0;

        loop {
            if i >= amounts.len() { break; }
            total = total + *amounts.at(i);
            i += 1;
        };

        assert(total == self.amount.read(), 'Invalid distribution');

        // 💸 Execute payments
        let mut j: usize = 0;
        loop {
            if j >= staff_addresses.len() { break; }
            usdc.transfer(*staff_addresses.at(j), *amounts.at(j));
            j += 1;
        };

        self.is_released.write(true);
    }

    #[external(v0)]
    fn get_details(
        self: @ContractState
    ) -> (
        ContractAddress,
        ContractAddress,
        u256,
        bool
    ) {
        (
            self.payer.read(),
            self.payee.read(),
            self.amount.read(),
            self.is_released.read()
        )
    }
}