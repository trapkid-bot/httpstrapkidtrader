/* eslint-disable no-promise-executor-return */
import debounce from 'lodash.debounce';
import { getLocalizedErrorMessage } from '@/constants/backend-error-messages';
import { localize } from '@deriv-com/translations';
import { getLast } from '../../../utils/binary-utils';
import { observer as globalObserver } from '../../../utils/observer';
import { api_base } from '../../api/api-base';
import { getDirection, getLastDigit } from '../utils/helpers';
import { expectPositiveInteger } from '../utils/sanitize';
import * as constants from './state/constants';
import { analyzerSignalService } from '@/services/analyzer-signal.service';

let tickListenerKey;

export default Engine =>
    class Ticks extends Engine {
        async watchTicks(symbol) {
            // TRAPKID ANALYZER MODE:
            // The Analyzer is the ONLY source of market selection and live ticks.
            // Do not open a second Deriv tick stream here. Deriv is used only for
            // the actual contract transaction when Run is clicked.
            if (this.analyzerFeedUnsubscribe) {
                this.analyzerFeedUnsubscribe();
                this.analyzerFeedUnsubscribe = null;
            }

            const handleAnalyzerEvent = event => {
                if (event.type === 'MARKET_SELECTED') {
                    const selectedMarket = event.market;
                    if (selectedMarket) {
                        this.symbol = selectedMarket;
                        if (this.tradeOptions && !this.analyzerSignal) {
                            this.tradeOptions.symbol = selectedMarket;
                        }
                    }
                    return;
                }

                if (event.type !== 'TICK' || !event.tick) return;

                const tick = event.tick;
                if (tick.symbol) this.symbol = tick.symbol;
                if (this.tradeOptions && !this.analyzerSignal && tick.symbol) {
                    this.tradeOptions.symbol = tick.symbol;
                }

                // Preserve the Analyzer's exact quote, epoch and digit.
                this.latestTick = {
                    symbol: tick.symbol || this.symbol,
                    quote: Number(tick.quote),
                    epoch: Number(tick.epoch),
                    digit: Number(tick.digit),
                    receivedAt: tick.receivedAt || Date.now(),
                    pipSize: tick.pipSize,
                };

                if (this.is_proposal_subscription_required) {
                    this.checkProposalReady();
                }

                const currentDigit = Number(tick.digit);
                const targetDigit = this.analyzerSignal
                    ? Number(this.analyzerSignal.lockedDigit)
                    : null;

                // Two-tick Analyzer execution telemetry. The Analyzer's tick
                // stream, not a second Deriv subscription, drives this state.
                if (this.analyzerSignal && this.contractId && !this.isSold) {
                    const targetDetected = currentDigit === targetDigit;

                    analyzerSignalService.publishExecution({
                        state: targetDetected ? 'TARGET_DETECTED' : 'MONITORING',
                        signalId: this.analyzerSignal.signalId,
                        symbol: tick.symbol || this.tradeOptions?.symbol || this.symbol,
                        contractType: 'DIGITMATCH',
                        prediction: targetDigit,
                        targetDigit,
                        contractId: this.contractId,
                        currentQuote: Number(tick.quote),
                        currentDigit,
                        epoch: Number(tick.epoch),
                        tickEpoch: Number(tick.epoch),
                        entryEpoch: this.analyzerEntryEpoch || null,
                        analyzerLockedEntryQuote: Number(this.analyzerSignal.lockedQuote ?? this.analyzerSignal.entryQuote ?? 0) || null,
                        isSellAvailable: this.isSellAvailable,
                        bidPrice: Number(this.data?.contract?.bid_price),
                        buyPrice: Number(this.data?.contract?.buy_price),
                        profit: Number(this.data?.contract?.profit),
                    });
                }

                this.store.dispatch({ type: constants.NEW_TICK, payload: Number(tick.epoch) });
            };

            // Subscribe once and replay the Analyzer's current snapshot so the
            // DBot immediately mirrors the currently selected market/feed.
            this.analyzerFeedUnsubscribe = analyzerSignalService.subscribe(handleAnalyzerEvent);
            const snapshot = analyzerSignalService.getSnapshot();

            if (snapshot.selectedMarket) {
                this.symbol = snapshot.selectedMarket;
                if (this.tradeOptions && !this.analyzerSignal) {
                    this.tradeOptions.symbol = snapshot.selectedMarket;
                }
            }

            if (snapshot.feed) {
                handleAnalyzerEvent({ type: 'TICK', tick: snapshot.feed });
            }

            globalObserver.emit(
                'ui.log.info',
                'TRAPKID ANALYZER: live market/tick feed is sourced exclusively from the Analyzer.'
            );
        }

        checkTicksPromiseExists() {
            return this.$scope.ticksService.ticks_history_promise;
        }

        getTicks(toString = false) {
            const history = analyzerSignalService.getSnapshot().feedHistory || [];
            const values = history.map(tick => {
                const value = Number(tick.quote);
                return toString ? String(value) : value;
            });
            return Promise.resolve(values);
        }

        getLastTick(raw, toString = false) {
            const feed = analyzerSignalService.getSnapshot().feed;
            if (!feed) return Promise.reject(new Error('Analyzer live feed is not connected.'));

            if (raw) return Promise.resolve({ ...feed });

            const value = Number(feed.quote);
            return Promise.resolve(toString ? String(value) : value);
        }

        getLastDigit() {
            return new Promise(resolve => this.getLastTick(false, true).then(tick => resolve(getLastDigit(tick))));
        }

        getLastDigitList() {
            return new Promise(resolve => this.getTicks().then(ticks => resolve(this.getLastDigitsFromList(ticks))));
        }
        getLastDigitsFromList(ticks) {
            const digits = ticks.map(tick => {
                return getLastDigit(tick.toFixed(this.getPipSize()));
            });
            return digits;
        }

        checkDirection(dir) {
            return new Promise(resolve =>
                this.$scope.ticksService
                    .request({ symbol: this.symbol })
                    .then(ticks => resolve(getDirection(ticks) === dir))
            );
        }

        getOhlc(args) {
            const { granularity = this.options.candleInterval || 60, field } = args || {};

            return new Promise(resolve => {
                this.$scope.ticksService
                    .request({ symbol: this.symbol, granularity })
                    .then(ohlc => resolve(field ? ohlc.map(o => o[field]) : ohlc));
            });
        }

        getOhlcFromEnd(args) {
            const { index: i = 1 } = args || {};

            const index = expectPositiveInteger(Number(i), localize('Index must be a positive integer'));

            return new Promise(resolve => this.getOhlc(args).then(ohlc => resolve(ohlc.slice(-index)[0])));
        }

        getPipSize() {
            const feed = analyzerSignalService.getSnapshot().feed;
            if (Number.isInteger(Number(feed?.pipSize))) return Number(feed.pipSize);
            return this.$scope?.ticksService?.pipSizes?.[this.symbol] ?? 2;
        }

        async requestAccumulatorStats() {
            const subscription_id = this.subscription_id_for_accumulators;
            const is_proposal_requested = this.is_proposal_requested_for_accumulators;
            const proposal_request = {
                ...window.Blockly.accumulators_request,
                amount: this?.tradeOptions?.amount,
                basis: this?.tradeOptions?.basis,
                contract_type: 'ACCU',
                currency: this?.tradeOptions?.currency,
                growth_rate: this?.tradeOptions?.growth_rate,
                proposal: 1,
                subscribe: 1,
                underlying_symbol: this?.tradeOptions?.symbol,
            };
            if (!subscription_id && !is_proposal_requested) {
                this.is_proposal_requested_for_accumulators = true;
                if (proposal_request) {
                    await api_base?.api?.send(proposal_request);
                }
            }
        }

        async handleOnMessageForAccumulators() {
            let ticks_stayed_in_list = [];
            return new Promise(resolve => {
                const subscription = api_base.api.onMessage().subscribe(({ data }) => {
                    if (data.msg_type === 'proposal') {
                        try {
                            this.subscription_id_for_accumulators = data.subscription.id;
                            const stat_list = (data.proposal.contract_details.ticks_stayed_in || []).flat().reverse();
                            ticks_stayed_in_list = [...stat_list, ...ticks_stayed_in_list];
                            if (ticks_stayed_in_list.length > 0) resolve(ticks_stayed_in_list);
                        } catch (error) {
                            globalObserver.emit('Unexpected message type or no proposal found:', error);
                        }
                    }
                });
                api_base.pushSubscription(subscription);
            });
        }

        async fetchStatsForAccumulators() {
            try {
                const debouncedAccumulatorsRequest = debounce(() => this.requestAccumulatorStats(), 300);
                debouncedAccumulatorsRequest();
                const ticks_stayed_in_list = await this.handleOnMessageForAccumulators();
                return ticks_stayed_in_list;
            } catch (error) {
                globalObserver.emit('Error in subscription promise:', error);
                throw error;
            } finally {
                await api_base?.api?.send({ forget_all: 'proposal' });
                this.is_proposal_requested_for_accumulators = false;
                this.subscription_id_for_accumulators = null;
            }
        }

        async getCurrentStat() {
            try {
                const ticks_stayed_in = await this.fetchStatsForAccumulators();
                return ticks_stayed_in?.[0];
            } catch (error) {
                globalObserver.emit('Error fetching current stat:', error);
            }
        }

        async getStatList() {
            try {
                const ticks_stayed_in = await this.fetchStatsForAccumulators();
                return ticks_stayed_in?.slice(0, 100);
            } catch (error) {
                globalObserver.emit('Error fetching current stat:', error);
            }
        }

        async getDelayTickValue(tick_value) {
            return new Promise((resolve, reject) => {
                try {
                    const ticks = [];
                    const symbol = this.symbol;

                    const resolveAndExit = () => {
                        this.$scope.ticksService.stopMonitor({
                            symbol,
                            key: '',
                        });
                        resolve(ticks);
                        ticks.length = 0;
                    };

                    const watchTicks = tick_list => {
                        ticks.push(tick_list);
                        const current_tick = ticks.length;
                        if (current_tick === tick_value) {
                            resolveAndExit();
                        }
                    };

                    const delayExecution = tick_list => watchTicks(tick_list);

                    if (Number(tick_value) <= 0) resolveAndExit();
                    this.$scope.ticksService.monitor({ symbol, callback: delayExecution });
                } catch (error) {
                    reject(new Error(`Failed to start tick monitoring: ${error.message}`));
                }
            });
        }
    };
