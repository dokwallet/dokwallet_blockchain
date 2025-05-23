import {validateAddressString} from '@glif/filecoin-address';
import {keyPairFromPrivateKey} from '@nodefactory/filecoin-address';
import BigNumber from 'bignumber.js';
import {config, IS_SANDBOX} from 'dok-wallet-blockchain-networks/config/config';
import {
  convertToSmallAmount,
  parseBalance,
} from 'dok-wallet-blockchain-networks/helper';
import {getFreeRPCUrl} from 'dok-wallet-blockchain-networks/rpcUrls/rpcUrls';
import {FilScan} from 'dok-wallet-blockchain-networks/service/filScan';
import {
  HttpJsonRpcConnector,
  LotusClient,
  LotusWalletProvider,
  MnemonicWalletProvider,
} from 'filecoin.js';

const derivedPath = IS_SANDBOX ? "m/44'/1'/0'/0/0" : "m/44'/461'/0'/0/0";

export const FilecoinChain = chain_name => {
  const allRpcUrls = getFreeRPCUrl(chain_name);

  const retryFunc = async (cb, defaultResponse) => {
    for (let i = 0; i < allRpcUrls.length; i++) {
      try {
        const connector = new HttpJsonRpcConnector(allRpcUrls[i]);
        const lotusClient = new LotusClient(connector);
        const wallet = new LotusWalletProvider(lotusClient);
        return await cb({wallet, lotusClient});
      } catch (e) {
        console.log('Error for filecoin rpc', allRpcUrls[i], 'Errors:', e);
        if (i === allRpcUrls.length - 1) {
          if (defaultResponse) {
            return defaultResponse;
          } else {
            throw e;
          }
        }
      }
    }
  };

  function calculateFilecoinGasFee(gasUsed, gasLimit, baseFee, gasPremium) {
    const bnGasUsed = new BigNumber(gasUsed);
    const bnGasLimit = new BigNumber(gasLimit);
    const bnBaseFee = new BigNumber(baseFee);
    const bnGasPremium = new BigNumber(gasPremium);
    const overEstimation = bnGasLimit.minus(bnGasUsed.times(11).div(10));
    const overEstimationBurn = overEstimation.gt(0)
      ? overEstimation.times(bnGasLimit.minus(bnGasUsed)).div(bnGasUsed)
      : new BigNumber(0);

    const totalFee = bnGasUsed
      .times(bnBaseFee)
      .plus(bnGasLimit.times(bnGasPremium))
      .plus(overEstimationBurn.times(bnBaseFee));

    return totalFee.toString();
  }

  return {
    isValidAddress: ({address}) => {
      try {
        return validateAddressString(address);
      } catch (e) {
        console.error('Error in isValidAddress filecoin', e);
        return false;
      }
    },
    isValidPrivateKey: async ({privateKey}) => {
      try {
        const generatedKeypair = await FilecoinChain(
          chain_name,
        ).createWalletByPrivateKey({privateKey});
        return !!generatedKeypair?.address;
      } catch (e) {
        console.error('Error in isValidPrivateKey filecoin', e);
        return false;
      }
    },
    createWalletByPrivateKey: async ({privateKey}) => {
      try {
        const generatedKeypair = keyPairFromPrivateKey(
          privateKey,
          IS_SANDBOX ? 't' : 'f',
        );
        return {
          address: generatedKeypair?.address?.toString(),
          privateKey: privateKey,
        };
      } catch (e) {
        console.error('Error in create wallet from private key in filecoin', e);
        return null;
      }
    },
    getBalance: async ({address}) =>
      retryFunc(async ({wallet}) => {
        try {
          const balance = await wallet.getBalance(address);
          return balance.toString();
        } catch (e) {
          console.error('Error in get balance from filecoin', e);
          throw e;
        }
      }, '0'),
    getEstimateFee: async ({toAddress, fromAddress, amount}) =>
      retryFunc(async ({wallet}) => {
        try {
          const amountToSend = convertToSmallAmount(amount, 18);
          const nonce = await wallet.getNonce(fromAddress);
          const {GasFeeCap, GasLimit, GasPremium} =
            await wallet.estimateMessageGas({
              To: toAddress,
              From: fromAddress,
              Value: amountToSend,
              Nonce: nonce,
            });
          const {baseFee, gasUsed} = await FilScan.getTransactionFees();
          const totalGasFee = calculateFilecoinGasFee(
            gasUsed.toString(),
            GasLimit.toString(),
            baseFee.toString(),
            GasPremium.toString(),
          );
          return {
            fee: parseBalance(totalGasFee, 18),
            estimateGas: {
              nonce: nonce,
              gasLimit: GasLimit,
              gasFeeCap: GasFeeCap.toString(),
              gasPremium: GasPremium.toString(),
            },
          };
        } catch (e) {
          console.error('Error in filecoin gas fee', e);
          throw e;
        }
      }, null),
    getTransactions: async ({address}) => {
      try {
        const transactions = await FilScan.getTransactions({address});
        return transactions.map(item => {
          const txHash = item?.txHash || '';
          return {
            amount: item?.amount?.toString(),
            link: txHash ? txHash.substring(0, 13) + '...' : '',
            url: `${config.FILECOIN_SCAN_URL}/message/${txHash}`,
            status: item?.status === true ? 'SUCCESS' : 'FAILED',
            date: item?.timestamp ? new Date(item.timestamp) : new Date(),
            from: item?.from,
            to: item?.to,
          };
        });
      } catch (e) {
        console.error('error in get transactions from filecoin', e);
        return [];
      }
    },
    send: async ({
      to,
      from,
      amount,
      phrase,
      estimateGas: {nonce, gasLimit, gasFeeCap, gasPremium},
    }) =>
      retryFunc(async ({wallet, lotusClient}) => {
        try {
          const walletProvider = new MnemonicWalletProvider(
            lotusClient,
            phrase,
            derivedPath,
          );
          await walletProvider.newAddress();
          const amountToSend = convertToSmallAmount(amount, 18);
          const message = await wallet.createMessage({
            To: to,
            From: from,
            Nonce: nonce,
            Value: amountToSend,
            GasLimit: gasLimit,
            GasFeeCap: new BigNumber(gasFeeCap),
            GasPremium: new BigNumber(gasPremium),
          });
          const sendMessage = await walletProvider.signMessage(message);
          const sendSignedMessage = await walletProvider.sendSignedMessage(
            sendMessage,
          );
          return sendSignedMessage['/'];
        } catch (e) {
          console.error('Error in send filecoin transaction', e);
          throw e;
        }
      }, null),
    waitForConfirmation: async ({transaction, interval, retries}) =>
      retryFunc(async ({lotusClient}) => {
        const sleep = ms =>
          new Promise(resolve => setTimeout(() => resolve('pending'), ms));
        const awaitTransactionConfirmation = async () => {
          try {
            const receipt = await lotusClient.state.waitMsg(
              {'/': transaction},
              0,
            );
            if (receipt?.Receipt?.ExitCode === 0) {
              return receipt;
            } else {
              throw new Error('Transaction failed');
            }
          } catch (e) {
            if (e.code >= 500) {
              return 'pending';
            }
            throw e;
          }
        };
        return Promise.race([
          awaitTransactionConfirmation(),
          sleep(interval * retries),
        ]);
      }, null),
  };
};
