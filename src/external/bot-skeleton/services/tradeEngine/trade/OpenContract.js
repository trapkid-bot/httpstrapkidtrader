import { getRoundedNumber } from '@/components/shared';
import { api_base } from '../../api/api-base';
import { contract as broadcastContract, contractStatus } from '../utils/broadcast';
import { openContractReceived, sell } from './state/actions';
import { analyzerSignalService } from '@/services/analyzer-signal.service';

export default Engine =>
    class OpenContract extends Engine {
        observeOpenContract() {
            if (!api_base.api) return;
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'proposal_open_contract') {
                    const contract = data.proposal_open_contract;

                    if (!contract || !this.expectedContractId(contract?.contract_id)) {
                        return;
                    }

                    this.setContractFlags(contract);

                    this.data.contract = contract;

                    if (this.analyzerSignal && this.contractId) {
                        analyzerSignalService.publishExecution({
                            state: this.isSold ? 'SOLD' : this.isExpired ? 'SETTLED' : 'OPEN',
                            signalId: this.analyzerSignal.signalId,
                            symbol: this.tradeOptions?.symbol || this.symbol,
                            contractType: 'DIGITMATCH',
                            prediction: Number(this.analyzerSignal.lockedDigit),
                            targetDigit: Number(this.analyzerSignal.lockedDigit),
                            contractId: this.contractId,
                            entryQuote: Number(contract.entry_tick),
                            entryDigit: contract.entry_tick !== undefined
                                ? Number(String(contract.entry_tick_display_value ?? contract.entry_tick).replace(/[^0-9]/g, '').slice(-1))
                                : null,
                            currentQuote: Number(contract.current_spot),
                            currentDigit: contract.current_spot_display_value !== undefined
                                ? Number(String(contract.current_spot_display_value).replace(/[^0-9]/g, '').slice(-1))
                                : null,
                            bidPrice: Number(contract.bid_price),
                            buyPrice: Number(contract.buy_price),
                            isSellAvailable: this.isSellAvailable,
                            isExpired: this.isExpired,
                            isSold: this.isSold,
                            profit: Number(contract.profit),
                            payout: Number(contract.payout),
                            status: contract.status,
                        });
                    }

                    broadcastContract({ accountID: api_base.account_info.loginid, ...contract });

                    if (this.isSold) {
                        this.contractId = '';
                        clearTimeout(this.transaction_recovery_timeout);
                        this.updateTotals(contract);
                        contractStatus({
                            id: 'contract.sold',
                            data: contract.transaction_ids.sell,
                            contract,
                        });

                        if (this.afterPromise) {
                            this.afterPromise();
                        }

                        this.store.dispatch(sell());
                    } else {
                        this.store.dispatch(openContractReceived());
                    }
                }
            });
            api_base.pushSubscription(subscription);
        }

        waitForAfter() {
            return new Promise(resolve => {
                this.afterPromise = resolve;
            });
        }

        setContractFlags(contract) {
            const { is_expired, is_valid_to_sell, is_sold, entry_tick } = contract;

            this.isSold = Boolean(is_sold);
            this.isSellAvailable = !this.isSold && Boolean(is_valid_to_sell);
            this.isExpired = Boolean(is_expired);
            this.hasEntryTick = Boolean(entry_tick);
        }

        expectedContractId(contractId) {
            return this.contractId && contractId === this.contractId;
        }

        getSellPrice() {
            const { bid_price: bidPrice, buy_price: buyPrice, currency } = this.data.contract;
            return getRoundedNumber(Number(bidPrice) - Number(buyPrice), currency);
        }
    };
