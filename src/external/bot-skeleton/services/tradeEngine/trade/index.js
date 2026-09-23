import { applyMiddleware, createStore } from 'redux';
import { thunk } from 'redux-thunk';
import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { createError } from '../../../utils/error';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { checkBlocksForProposalRequest, doUntilDone } from '../utils/helpers';
import { expectInitArg } from '../utils/sanitize';
import { getAnalyzerSignal } from '@/services/analyzer-signal.service';
import { proposalsReady, start } from './state/actions';
import * as constants from './state/constants';
import rootReducer from './state/reducers';
import Balance from './Balance';
import OpenContract from './OpenContract';
import Proposal from './Proposal';
import Purchase from './Purchase';
import Sell from './Sell';
import Ticks from './Ticks';
import Total from './Total';

const watchBefore = store =>
    watchScope({
        store,
        stopScope: constants.DURING_PURCHASE,
        passScope: constants.BEFORE_PURCHASE,
        passFlag: 'proposalsReady',
    });

const watchDuring = store =>
    watchScope({
        store,
        stopScope: constants.STOP,
        passScope: constants.DURING_PURCHASE,
        passFlag: 'openContract',
    });

let prevTick;
const watchScope = ({ store, stopScope, passScope, passFlag }) => {
    if (store.getState().scope === stopScope) {
        return Promise.resolve(false);
    }
    return new Promise(resolve => {
        const unsubscribe = store.subscribe(() => {
            const newState = store.getState();

            if (newState.newTick === prevTick) return;
            prevTick = newState.newTick;

            if (newState.scope === passScope && newState[passFlag]) {
                unsubscribe();
                resolve(true);
            }

            if (newState.scope === stopScope) {
                unsubscribe();
                resolve(false);
            }
        });
    });
};

export default class TradeEngine extends Balance(Purchase(Sell(OpenContract(Proposal(Ticks(Total(class {}))))))) {
    constructor($scope) {
        super();
        this.observer = $scope.observer;
        this.$scope = $scope;
        this.observe();
        this.data = {
            contract: {},
            proposals: [],
        };
        this.subscription_id_for_accumulators = null;
        this.is_proposal_requested_for_accumulators = false;
        this.store = createStore(rootReducer, applyMiddleware(thunk));
    }

    init(...args) {
        const [token, options] = expectInitArg(args);
        const { symbol } = options;

        this.initArgs = args;
        this.options = options;
        this.startPromise = this.loginAndGetBalance(token);

        if (!this.checkTicksPromiseExists()) this.watchTicks(symbol);
    }

    start(tradeOptions) {
        if (!this.options) {
            throw createError('NotInitialized', getLocalizedErrorMessage('NotInitialized'));
        }

        globalObserver.emit('bot.running');

        this.analyzerSignal = null;
        this.analyzerEntryEpoch = 0;
        this.analyzerExitTriggered = false;
        this.analyzerAutoPurchase = false;

        const validated_trade_options = this.validateTradeOptions(tradeOptions);
        const analyzerSignal = getAnalyzerSignal();

        // TRAPKID MODE: Run is ONLY allowed to execute the locked Analyzer
        // digit as a DIGITMATCH contract. Never fall back to Blockly CALL/PUT.
        if (!analyzerSignal) {
            globalObserver.emit(
                'ui.log.error',
                'TRAPKID ANALYZER: No valid locked digit is available. Run cancelled; no Rise/Fall contract will be purchased.'
            );
            return;
        }

        const lockedDigit = Number(analyzerSignal.lockedDigit);
        if (!Number.isInteger(lockedDigit) || lockedDigit < 0 || lockedDigit > 9) {
            globalObserver.emit('ui.log.error', 'TRAPKID ANALYZER: Invalid locked digit. Run cancelled.');
            return;
        }

        this.analyzerSignal = analyzerSignal;
        this.analyzerAutoPurchase = true;

        this.tradeOptions = {
            ...validated_trade_options,
            basis: 'stake',
            contract_type: 'DIGITMATCH',
            prediction: lockedDigit,
            duration: 1,
            duration_unit: 't',
            symbol: analyzerSignal.symbol || this.options.symbol,
        };

        globalObserver.emit(
            'ui.log.info',
            `TRAPKID ANALYZER: DIGITMATCH ${this.tradeOptions.symbol} | prediction digit ${lockedDigit} | signal ${analyzerSignal.signalId}`
        );
        this.store.dispatch(start());
        this.checkLimits(this.tradeOptions);
        this.makeDirectPurchaseDecision();
    }

    loginAndGetBalance(token) {
        if (this.token === token) {
            return Promise.resolve();
        }
        this.accountInfo = api_base.account_info;
        this.token = api_base.token;
        return new Promise(resolve => {
            const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                if (data.msg_type === 'transaction' && data.transaction.action === 'sell') {
                    this.transaction_recovery_timeout = setTimeout(() => {
                        const { contract } = this.data;
                        const is_same_contract = contract.contract_id === data.transaction.contract_id;
                        const is_open_contract = contract.status === 'open';
                        if (is_same_contract && is_open_contract) {
                            doUntilDone(() => {
                                api_base.api.send({ proposal_open_contract: 1, contract_id: contract.contract_id });
                            }, ['PriceMoved']);
                        }
                    }, 1500);
                }
                resolve();
            });
            api_base.pushSubscription(subscription);
        });
    }

    observe() {
        this.observeOpenContract();
        this.observeBalance();
        this.observeProposals();
    }

    watch(watchName) {
        if (watchName === 'before') {
            return watchBefore(this.store);
        }
        return watchDuring(this.store);
    }

    makeDirectPurchaseDecision() {
        // Analyzer execution bypasses the normal Blockly countdown/strategy gate.
        // Run means BUY NOW using DIGITMATCH with the injected market and locked digit.
        if (this.analyzerAutoPurchase && this.analyzerSignal) {
            this.is_proposal_subscription_required = false;
            this.store.dispatch(proposalsReady());
            Promise.resolve().then(() => this.purchase('DIGITMATCH'));
            return;
        }

        const { has_payout_block, is_basis_payout } = checkBlocksForProposalRequest();
        this.is_proposal_subscription_required = has_payout_block || is_basis_payout;

        if (this.is_proposal_subscription_required) {
            this.makeProposals({ ...this.options, ...this.tradeOptions });
            this.checkProposalReady();
        } else {
            this.store.dispatch(proposalsReady());
        }
    }
}
