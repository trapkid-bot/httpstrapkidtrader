import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { observer as globalObserver } from '../../../utils/observer';
import { analyzerSignalService } from '@/services/analyzer-signal.service';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            // TrapKid Analyzer mode always purchases DIGITMATCH.
            // Analyzer CALL/PUT is signal context only.
            const effectiveContractType = 'DIGITMATCH';

            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            const onSuccess = response => {
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                if (this.analyzerSignal) {
                    this.analyzerEntryEpoch = Number(buy.purchase_time || Math.floor(Date.now() / 1000));
                    this.analyzerExitTriggered = false;
                    globalObserver.emit(
                        'ui.log.info',
                        `TRAPKID ANALYZER: DIGITMATCH entered immediately with prediction digit ${this.analyzerSignal.lockedDigit} on ${this.tradeOptions.symbol}`
                    );
                    analyzerSignalService.publishExecution({
                        state: 'ENTERED',
                        signalId: this.analyzerSignal.signalId,
                        symbol: this.tradeOptions.symbol,
                        contractType: 'DIGITMATCH',
                        prediction: Number(this.analyzerSignal.lockedDigit),
                        targetDigit: Number(this.analyzerSignal.lockedDigit),
                        contractId: buy.contract_id,
                        transactionId: buy.transaction_id,
                        entryQuote: Number(this.latestTick?.quote),
                        entryDigit: this.latestTick?.quote !== undefined
                            ? Number(String(this.latestTick.quote).replace('.', '').slice(-1))
                            : null,
                        entryEpoch: this.analyzerEntryEpoch,
                        buyPrice: Number(buy.buy_price ?? this.tradeOptions.amount),
                        stake: Number(this.tradeOptions.amount),
                        duration: 1,
                        durationUnit: 't',
                    });
                }
                this.store.dispatch(purchaseSuccessful());

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type: effectiveContractType,
                    buy_price: buy.buy_price,
                });
            };

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(effectiveContractType);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }

            const trade_option = tradeOptionToBuy(effectiveContractType, this.tradeOptions);
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
