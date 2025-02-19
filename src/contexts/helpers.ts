/* eslint-disable eqeqeq */
/* eslint-disable @typescript-eslint/no-unused-vars */

import { web3 } from '@project-serum/anchor';
import {
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  ConfirmOptions,
  SYSVAR_RENT_PUBKEY,
  Connection,
  TransactionSignature,
  LAMPORTS_PER_SOL
} from '@solana/web3.js';

import { WalletContextState } from "@solana/wallet-adapter-react";

// for rest function
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import * as anchor from '@project-serum/anchor';
import * as borsh from 'borsh';
import { METADATA_SCHEMA, Metadata } from './processMetaplexAccounts';
import { NotificationManager } from 'react-notifications';
import {
  getMultipleTransactions,
  sendMultiTransactions,
  sendSignTransactions,
} from './utils';
import {
  PROGRAM_ID,
  TOKEN_METADATA_PROGRAM_ID,
  REWARD_TOKEN_DECIMAL,
  PERCENTAGE_DECIMALS,
  PYTH_ACCOUNT,
  USDC_TOKEN_MINT,
  REWARD_TYPE_SOL,
  FRONK_DECIMAL,
  FRONK_MINT,
} from './constants';

import * as keys from './keys';


const MAX_ITEM_COUNT = 15;

const IDL = require('./anchor_idl/idl/spin');


const superAdminKey = new PublicKey("BpUBejWAKv3VpNci2isyjDQsUGP4FNu5biY1GmMRVdJB");

let program: any = null;
let provider: any = null;
let poolAccountPDA: any = null;
let poolVaultPDA: any = null;


export const getProgram = (connection: any) => {
  let cloneWindow: any = window;
  provider = new anchor.Provider(connection, cloneWindow['solana'], anchor.Provider.defaultOptions())
  program = new anchor.Program(IDL, PROGRAM_ID, provider);

  return program;
};


export const isAdminWallet = async (wallet: any) => {
  if (!wallet.publicKey) {
    return 2;
  }

  if (!program) {
    if (wallet.publicKey.equals(superAdminKey)) {
      return 1;
    } else {
      return 2;
    }
  }

  let pool = await program.account.pool.fetchNullable(poolVaultPDA);
  if (wallet.publicKey.equals(pool.superadmin)) {
    return 0;
  }

  let adminInfo = await getAdminList();
  for (let i = 0; i < adminInfo.length; i++) {
    if (wallet.publicKey.equals(adminInfo[i])) {
      return 1;
    }
  }


  return 2;
}

export const getAdminList = async () => {
  let adminInfoKey = await keys.getAdminInfoKey();
  let adminInfo = await program.account.adminInfo.fetch(adminInfoKey);
  let arrAdmins = [];
  for (let i = 0; i < adminInfo.count; i++) {
    arrAdmins.push(adminInfo.adminList[i]);
  }

  return arrAdmins;
}

const createAssociatedTokenAccountInstruction = (
  associatedTokenAddress: anchor.web3.PublicKey,
  payer: anchor.web3.PublicKey,
  walletAddress: anchor.web3.PublicKey,
  splTokenMintAddress: anchor.web3.PublicKey
) => {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedTokenAddress, isSigner: false, isWritable: true },
    { pubkey: walletAddress, isSigner: false, isWritable: false },
    { pubkey: splTokenMintAddress, isSigner: false, isWritable: false },
    {
      pubkey: anchor.web3.SystemProgram.programId,
      isSigner: false,
      isWritable: false,
    },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    {
      pubkey: anchor.web3.SYSVAR_RENT_PUBKEY,
      isSigner: false,
      isWritable: false,
    },
  ];
  return new anchor.web3.TransactionInstruction({
    keys,
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([]),
  });
};

const getTokenWallet = async (
  wallet: anchor.web3.PublicKey,
  mint: anchor.web3.PublicKey
) => {
  return (
    await anchor.web3.PublicKey.findProgramAddress(
      [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  )[0];
};

export const initialize = async (wallet: any, connection: any, checkAdminInit: any) => {
  program = getProgram(connection);

  if (checkAdminInit) {
    if (await getPoolInfo(connection) == null) {
      return false;
    }

    let stateDataKey = await program.account.spinItemList.all([]);
    poolAccountPDA = stateDataKey[0].publicKey;

    return true;
  }

  const _pool = await keys.getPoolKey();

  poolVaultPDA = _pool;
  let poolAccountSeed = "spin-wheel-pool";
  poolAccountPDA = await PublicKey.createWithSeed(
    wallet.publicKey,
    poolAccountSeed,
    program.programId,
  );

  if ((await connection.getAccountInfo(poolAccountPDA)) == null) {
    console.log('initialize start...', wallet);
    const adminSettingKey = await keys.getSettingInfoKey();
    const adminListKey = await keys.getAdminInfoKey();

    let transaction = new Transaction();

    let POOL_SPACE = 5020;
    transaction.add(SystemProgram.createAccountWithSeed({
      fromPubkey: wallet.publicKey,
      basePubkey: wallet.publicKey,
      seed: poolAccountSeed,
      newAccountPubkey: poolAccountPDA,
      lamports: await provider.connection.getMinimumBalanceForRentExemption(POOL_SPACE),
      space: POOL_SPACE,
      programId: program.programId,
    }));
    

    transaction.add(
      program.instruction.initialize(
        {
          accounts: {
            initializer: wallet.publicKey,
            pool: poolVaultPDA,
            lastUsers: await keys.getLastUsersKey(),
            superAdmin: wallet.publicKey,
            state: poolAccountPDA,
            // settingInfo: adminSettingKey,
            adminInfo: adminListKey,
            vault: await keys.getVaultKey(),
            systemProgram: SystemProgram.programId,
          },
        }
      )
    );

    try {
      await send(connection, wallet, transaction);
    } catch (error) {
      return false;
    }
  }

  return true;
}

export const setPayInfo = async (wallet: any, connection: any, price: any, devFee: any, devWallet: PublicKey, burnFee: any, burnWallet: PublicKey) => {
  program = getProgram(connection);

  try {
    const adminInfo = await keys.getAdminInfoKey();
    let transaction = new Transaction();
    transaction.add(program.instruction.setPayInfo(new anchor.BN(price * FRONK_DECIMAL), new anchor.BN(devFee * (10 ** PERCENTAGE_DECIMALS)), new PublicKey(devWallet), new anchor.BN(burnFee * (10 ** PERCENTAGE_DECIMALS)), new PublicKey(burnWallet),
      {
        accounts: {
          admin: wallet.publicKey,
          pool: poolVaultPDA,
          adminInfo: adminInfo,
        }
      }
    ));
    const result = await send(connection, wallet, transaction);
    return result;
  } catch (error) {
    console.log('error', error);
    return null;
  }
}

const convertToPubKey = (pubKeyStrList: []) => {
  let pkList = [];
  for (let i = 0; i < pubKeyStrList.length; i++) {
    try {
      pkList.push(new PublicKey(pubKeyStrList[i]));
    } catch (e) {
    }
  }

  return pkList;
}

export const setItemInfos = async (wallet: any, connection: any, itemInfos: []) => {

  let token_addr_list = [];
  let token_type_list = [];
  let ratio_list = [];
  let amount_list = [];
  // for (let i = 0; i < MAX_ITEM_COUNT; i++) {
  for (let i = 0; i < itemInfos.length; i++) {
    if (i < itemInfos.length) {
      token_addr_list.push(convertToPubKey(itemInfos[i]["tokenAddrList"]));
      token_type_list.push(Number(itemInfos[i]["tokenType"]));
      ratio_list.push(Number(itemInfos[i]["winningPercentage"]) * (10 ** PERCENTAGE_DECIMALS));
      amount_list.push(new anchor.BN(itemInfos[i]["price"] * (10 ** REWARD_TOKEN_DECIMAL)));
    } else {
      token_addr_list.push([]);
      token_type_list.push(0);
      ratio_list.push(0);
      amount_list.push(new anchor.BN(0));
    }
  }

  //console.log('token addrs', token_addr_list);
  //console.log('ratios', ratio_list);
  //console.log('amounts', amount_list);

  let instructions: any = [];
  for (let i = 0; i < itemInfos.length; i++) {
    let item_idx = i;
    instructions.push(
      program.instruction.setItem(
        item_idx,
        token_addr_list[item_idx],
        token_addr_list[item_idx].length,
        token_type_list[item_idx],
        ratio_list[item_idx],
        amount_list[item_idx],
        itemInfos.length,
        {
          accounts: {
            superadmin: wallet.publicKey,
            pool: poolVaultPDA,
            state: poolAccountPDA,
          },
        }
      )
    );
  }

  if (instructions.length > 0) {
    let instructionSet = await getMultipleTransactions(connection, wallet, instructions);
    let res = await sendMultiTransactions(connection, wallet, instructionSet);
    console.log({res});
  }

  return true;
}

const getIdFromName = (name: string): number => {
  //"WolfHero #11"
  // "Seat #8"
  let len = name.length;
  let sharp = name.search('#');
  return parseInt(name.substring(sharp + 1, len)) - 1;
}


// eslint-disable-next-line no-control-regex
const METADATA_REPLACE = new RegExp("\u0000", "g");
function decodeMetadata(buffer: any) {
  const metadata = borsh.deserializeUnchecked(
    METADATA_SCHEMA,
    Metadata,
    buffer
  );

  metadata.data.name = metadata.data.name.replace(METADATA_REPLACE, "");
  metadata.data.uri = metadata.data.uri.replace(METADATA_REPLACE, "");
  metadata.data.symbol = metadata.data.symbol.replace(METADATA_REPLACE, "");
  return metadata;
}

export const getNFTs = async (connection: any, nftAddr: PublicKey) => {

  const metadataAccount = (
    await PublicKey.findProgramAddress(
      [
        Buffer.from('metadata'),
        TOKEN_METADATA_PROGRAM_ID.toBuffer(),
        nftAddr.toBuffer(),
      ],
      TOKEN_METADATA_PROGRAM_ID,
    )
  )[0];

  let accInfo = await connection.getAccountInfo(metadataAccount);

  let nftAttr = decodeMetadata(accInfo.data);
  //console.log("nft Name =", nftAttr.data.name);
  //console.log("nft Id =", getIdFromName(nftAttr.data.name));
  //console.log('nftAttr Data', nftAttr);

  return nftAttr.data;
}

export const getItemInfos = async () => {
  if (poolAccountPDA == false) {
    return null;
  }

  let vaultKey: any = await keys.getVaultKey();

  try {
    let _state = await program.account.spinItemList.fetch(
      poolAccountPDA
    );
    return _state;
  } catch (error) {
    //console.log('getItemInfos error : ', error);
    return null;
  }
}

export const sendToContract = async (wallet: any, connection: any, tokenAddr: any, amount: any) => {

  if (tokenAddr.length == 0) {
    let vaultKey: any = await keys.getVaultKey();
    let transaction = new Transaction();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: vaultKey,
        lamports: (amount * web3.LAMPORTS_PER_SOL),
      })
    );
    await send(connection, wallet, transaction);

    return;
  }

  let mintWC = new PublicKey(tokenAddr);
  let payAmountToken = amount;

  let transaction = new Transaction();

  var myToken = new Token(
    connection,
    mintWC,
    TOKEN_PROGRAM_ID,
    wallet
  );

  let mintInfo = null;
  try {
    mintInfo = await myToken.getMintInfo();
  } catch (error) {
    NotificationManager.error('You have no enough token');
    return false;
  }

  //console.log('=========== mintInfo ==========', mintInfo);
  var sourcePayAccount = null;
  try {
    sourcePayAccount = await myToken.getOrCreateAssociatedAccountInfo(wallet.publicKey);
    if ((await connection.getAccountInfo(sourcePayAccount.address)) == null) {
      NotificationManager.error('You have no enough token');
      //console.log('Zero balance');
      return false;
    }
  } catch (error) {
    NotificationManager.error('You have no enough token');
    //console.log('Cannot find payment tokens in your wallet');
    return false;
  }

  var destPayAccount = await getTokenWallet(poolVaultPDA, mintWC);

  if ((await connection.getAccountInfo(destPayAccount)) == null) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        destPayAccount,
        wallet.publicKey,
        poolVaultPDA,
        mintWC
      )
    );
  }

  let srcAmount = await provider.connection.getTokenAccountBalance(sourcePayAccount.address);
  console.log('uiAmount', srcAmount, payAmountToken, mintInfo.decimals);
  if (srcAmount.value.uiAmount < payAmountToken) {
    NotificationManager.error('You have no enough token');
    //console.log('Infucient balance : ', srcAmount.uiAmount, payAmountToken);
    return false;
  }

  transaction.add(
    Token.createTransferInstruction(
      TOKEN_PROGRAM_ID,
      sourcePayAccount.address,
      destPayAccount,
      wallet.publicKey,
      [],
      payAmountToken * (10 ** mintInfo.decimals),
    )
  );
  console.log('transaction', transaction);
  const res = await send(connection, wallet, transaction);
  console.log({res});
}

export const transferFromWalletToContract = async (wallet: any, connection: any, transaction: Transaction, isPaySol: any) => {
  // console.log('Start to transfer from wallet to contract...');
  let _info = await getPoolInfo(connection);
  let mintWC = _info.paymentToken;
  let payAmountToken = _info.paymentAmount.toNumber() / (10 ** REWARD_TOKEN_DECIMAL);
  let payAmountSol = _info.paymentSolamount.toNumber() / LAMPORTS_PER_SOL;

  if (isPaySol == false) {
    var myToken = new Token(
      connection,
      mintWC,
      TOKEN_PROGRAM_ID,
      wallet
    );

    let mintInfo = null;
    try {
      mintInfo = await myToken.getMintInfo();
    } catch (error) {
      NotificationManager.error('You have no enough token');
      return false;
    }

    //console.log('=========== mintInfo ==========', mintInfo);
    var sourcePayAccount = null;
    try {
      sourcePayAccount = await myToken.getOrCreateAssociatedAccountInfo(wallet.publicKey);
      if ((await connection.getAccountInfo(sourcePayAccount.address)) == null) {
        NotificationManager.error('You have no enough token');
        //console.log('Zero balance');
        return false;
      }
    } catch (error) {
      NotificationManager.error('You have no enough token');
      //console.log('Cannot find payment tokens in your wallet');
      return false;
    }

    var destPayAccount = await getTokenWallet(poolVaultPDA, mintWC);

    if ((await connection.getAccountInfo(destPayAccount)) == null) {
      transaction.add(
        createAssociatedTokenAccountInstruction(
          destPayAccount,
          wallet.publicKey,
          poolVaultPDA,
          mintWC
        )
      );
    }

    let srcAmount = await provider.connection.getTokenAccountBalance(sourcePayAccount.address);
    if (srcAmount.uiAmount < payAmountToken) {
      //console.log('Infucient balance : ', srcAmount.uiAmount, payAmountToken);
      return false;
    }

    transaction.add(
      Token.createTransferInstruction(
        TOKEN_PROGRAM_ID,
        sourcePayAccount.address,
        destPayAccount,
        wallet.publicKey,
        [],
        payAmountToken * (10 ** mintInfo.decimals),
      )
    );
  } else {
    let vaultKey: any = await keys.getVaultKey();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: vaultKey, // poolVaultPDA,
        lamports: (payAmountSol * web3.LAMPORTS_PER_SOL),
      })
    );
  }

  try {
    // await wallet.sendTransaction(transaction, connection);
    //console.log("SUCCESS");

  } catch (error) {
    //console.log('rejected error : ', error);
    // NotificationManager.error('You should pay to play game');
    // return -2;
  }

  //console.log('End to transfer from wallet to contract...');

  return true;
}

const asyncGetPda = async (
  seeds: Buffer[],
  programId: PublicKey
): Promise<[PublicKey, number]> => {
  const [pubKey, bump] = await PublicKey.findProgramAddress(seeds, programId);
  return [pubKey, bump];
};

export const getUserStateData = async (wallet: any) => {

  let userStateKey = await keys.getUserStateKey(wallet.publicKey);

  const stateData = await program.account.userState.fetchNullable(
    userStateKey
  );

  return stateData;
}

export const spinWheel = async (wallet: any, connection: any) => {
  program = getProgram(connection);


  let rand = Math.floor(Math.random() * 100);

  let userStateKey = await keys.getUserStateKey(wallet.publicKey);
  let userStateData = await getUserStateData(wallet);
  let roundNum = userStateData ? userStateData.roundNum : 0;
  roundNum++;
  let userPendingKey = await keys.getUserPendingKey(wallet.publicKey, roundNum);

  let poolInfo = await getPoolInfo(connection);

  let fronkVault = await getTokenWallet(poolVaultPDA, FRONK_MINT);
  let fronkDev = await getTokenWallet(poolInfo.devWallet, FRONK_MINT);
  let fronkBurn = await getTokenWallet(poolInfo.burnWallet, FRONK_MINT);

  var myToken = new Token(
    connection,
    FRONK_MINT,
    TOKEN_PROGRAM_ID,
    wallet
  );
  var sourcePayAccount: any = null;
  try {
      sourcePayAccount = await myToken.getOrCreateAssociatedAccountInfo(wallet.publicKey);
      let accInfo = await connection.getAccountInfo(sourcePayAccount.address);
      if (accInfo == null) {
        NotificationManager.error('You have no enough Fronk token');
        return -1;
      }
  } catch (error) {
    NotificationManager.error('You have no enough Fronk token');
    return -1;
  }


  try {
    let transaction = new Transaction();
    const fronkVaultInfo = await connection.getAccountInfo(fronkVault);
    if (!fronkVaultInfo) {
      transaction.add(createAssociatedTokenAccountInstruction(
        fronkVault,
        wallet.publicKey,
        poolVaultPDA,
        FRONK_MINT))
    }
    const fronkDevInfo = await connection.getAccountInfo(fronkDev);
    if (!fronkDevInfo) {
      transaction.add(createAssociatedTokenAccountInstruction(
        fronkDev,
        wallet.publicKey,
        poolInfo.devWallet,
        FRONK_MINT))
    }
    const fronkBurnInfo = await connection.getAccountInfo(fronkBurn);
    if (!fronkBurnInfo) {
      transaction.add(createAssociatedTokenAccountInstruction(
        fronkBurn,
        wallet.publicKey,
        poolInfo.burnWallet,
        FRONK_MINT))
    }

    transaction.add(program.instruction.spinWheel(
      rand,
      new anchor.BN(roundNum),
      {
        accounts: {
          user: wallet.publicKey,
          pool: poolVaultPDA,
          lastUsers: await keys.getLastUsersKey(),
          state: poolAccountPDA,
          userState: userStateKey,
          userPendingstate: userPendingKey,
          fronkMint: FRONK_MINT,
          fronkVault: fronkVault,
          fronkDev: fronkDev,
          fronkBurn: fronkBurn,
          sourceAccount: sourcePayAccount.address,
          vault: await keys.getVaultKey(),
          devAccount: poolInfo.devWallet,
          burnAccount: poolInfo.burnWallet,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
          pythAccount: PYTH_ACCOUNT,
        }
      })
    )
    const res = await sendTransaction(connection, wallet, transaction);
    console.log('playgame', {res})
    if (!res) return -1;


  } catch (error) {
    return -1;
  }

  let _state = await program.account.spinItemList.fetch(
    poolAccountPDA
  );


  return _state.lastSpinindex;
}

const getUserPendingData = async (wallet: any) => {
  if (!wallet || !wallet.publicKey) {
    return [];
  }

  const result = await program.account.userPendingClaimState.all(
    [
      {
        memcmp: {
          offset: 8,
          bytes: wallet.publicKey.toBase58() /*new PublicKey('FLGBKhq3T4i1wpsudMKC8hSka6Bd9i9Pv85kgrFjVyym').toString()*/
        }
      }
    ]
  );

  return result;
}

export const getClaimStatus = async (wallet: any) => {
  const result = await getUserPendingData(wallet);
  console.log('result', result);
  for (let i = 0; i < result.length; i ++) {
    for (let j = 0; j < result[i]?.account?.count; j ++) {
      if (!result[i]?.account?.isClaimedList[j]) {
        // console.log('result[i]?.account?.isClaimedList[j]', result[i]?.account?.isClaimedList[j])
        // console.log('Number(result[i]?.account?.pendingAmountList[j])', Number(result[i]?.account?.pendingAmountList[j]));
        return true;
      }
    }
  }
  return false;
}

export const claimWinningItem = async (wallet: any, connection: any) => {

  // let _state = await program.account.spinItemList.fetch(
  //   poolAccountPDA
  // );

  // console.log('claim pool data', _state);

  // let rMintList = _state.rewardMintList[_state.lastSpinindex];
  // let amount = _state.amountList[_state.lastSpinindex].toNumber() / (10 ** REWARD_TOKEN_DECIMAL);
  // console.log('claim', _state.lastSpinindex, amount);
  //console.log('reward mint list', rMintList);

  let transaction1 = new Transaction();

  // let userStateData = await getUserStateData(wallet);
  // console.log('userStateData on claim', userStateData);
  // if (userStateData == null) {
  //   console.log('invalid user for claiming');
  //   return;
  // }

  const result = await getUserPendingData(wallet);
  console.log('result', result);
  let sum = 0, count = 0;
  for (let k = 0; k < result.length; k++) {
    let onePending = result[k].account;
    if (onePending.isSol) {
      let amount1 = onePending.solAmount.toNumber() / (10 ** REWARD_TOKEN_DECIMAL);
      if (await claimRewards(wallet, connection, transaction1, USDC_TOKEN_MINT, amount1, true, result[k].publicKey) == false) {
        NotificationManager.error('Contract has no enough reward sol');
        return false;
      }
    } else {
      for (let i = 0; i < onePending.count; i++) {
        if (onePending.isClaimedList[i]) continue;
        console.log('amount0', onePending.pendingAmountList[i].toNumber())
        sum += onePending.pendingAmountList[i].toNumber();
        count += 1;
        if (count >= 10) break;
        let amount1 = onePending.pendingAmountList[i].toNumber() / (10 ** REWARD_TOKEN_DECIMAL);
        const accountInfo = await connection.getAccountInfo(result[k].publicKey);
        if (!accountInfo) continue;
        if (await claimRewards(wallet, connection, transaction1, onePending.pendingMintList[i], amount1, false, result[k].publicKey) == false) {
          NotificationManager.error('Contract has no enough reward token');
          return false;
        }
        // console.log('one Pending', onePending.count)
        // console.log('amount1', amount1);
        // console.log('claim', onePending.isClaimedList[i]);
        // console.log('mint', onePending.pendingMintList[i]?.toString());
        // console.log('userPendingKey', result[k].publicKey.toString());
      }
    }
    if (count >= 10) break;
    // console.log('sum', sum, 'count', count);
    // close pending account
    let userPendingKey = await keys.getUserPendingKey(wallet.publicKey, onePending.roundNum);
    const accountInfo = await connection.getAccountInfo(userPendingKey);
    if (!accountInfo) continue;
    transaction1.add(
      program.instruction.closeUserPendingAcc(
        {
          accounts: {
            owner: wallet.publicKey,
            userPendingstate: userPendingKey
          },
        })
    );
  }

  try {
    await send(connection, wallet, transaction1);
  } catch (error) {
    //console.log('rejected error : ', error);
    return false;
  }

  return true;
}


export const deposit = async (wallet: any, connection: any, mintA: any, amount: any) => {
  var myToken = new Token(
    connection,
    mintA,
    TOKEN_PROGRAM_ID,
    wallet
  );

  let _state = await program.account.spinItemList.fetch(
    poolAccountPDA
  );

  let mintInfo = await myToken.getMintInfo();
  var sourceAccount = await myToken.getOrCreateAssociatedAccountInfo(wallet.publicKey);
  var destAccount = await myToken.getOrCreateAssociatedAccountInfo(_state.escrowAccount);

  let bnAmount = amount * (10 ** mintInfo.decimals);
  // let tokenAmount = await provider.connection.getTokenAccountBalance(sourceAccount.address);

  await myToken.transfer(
    sourceAccount.address,
    destAccount.address,
    wallet.publicKey,
    [wallet],
    new anchor.BN(bnAmount),
  );
}

const getContractSolAmount = async (connection: any) => {
  let vaultKey = await keys.getVaultKey();
  const walletBalance = await connection.getBalance(vaultKey);
  return walletBalance;
}

const withdrawSolFromContract = async (wallet: any, transaction: Transaction, amount: any, isLamports: boolean = false) => {
  if (!isLamports) {
    amount *= LAMPORTS_PER_SOL;
  }
  let vaultKey = await keys.getVaultKey();
  transaction.add(
    program.instruction.withdrawSol(
      new anchor.BN(amount),
      {
        accounts: {
          user: wallet.publicKey,
          vault: vaultKey,
          destAccount: wallet.publicKey,
          systemProgram: SystemProgram.programId,
        },
      })
  );
}

export const claimRewards = async (wallet: any, connection: any, transaction: Transaction, rMint: any, amount: any, isSol: any, userPendingKey: any) => {
  program = getProgram(connection);


  var myToken = new Token(
    connection,
    rMint,
    TOKEN_PROGRAM_ID,
    wallet.publicKey
  );

  let bnAmount = amount * LAMPORTS_PER_SOL;
  var sourceAccount = await getTokenWallet(poolVaultPDA, rMint);

  if (!isSol) {
    let mintInfo = await myToken.getMintInfo();
    if (!isSol && mintInfo.supply.cmp(new anchor.BN(1)) == 0 && mintInfo.decimals == 0) {
      // nft
      amount = 1;
    }
    bnAmount = amount * (10 ** mintInfo.decimals);
    console.log('bnAmount', bnAmount);
    // if (await connection.getAccountInfo(sourceAccount) == null) {
    //   await withdrawSolFromContract(wallet, transaction, amount);
    //   return true;
    // }

    // let srcAccTokenInfo = await myToken.getAccountInfo(sourceAccount);
    // if (new anchor.BN(bnAmount).cmp(srcAccTokenInfo.amount) != -1) {
    //   await withdrawSolFromContract(wallet, transaction, amount);
    //   console.log('claim, insufficient balance', bnAmount, srcAccTokenInfo.amount.toString());
    //   return true;
    // }
  }


  var destAccount = await getTokenWallet(wallet.publicKey, rMint);
  if ((await connection.getAccountInfo(destAccount)) == null) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        destAccount,
        wallet.publicKey,
        wallet.publicKey,
        rMint
      )
    );
  }

  if ((await connection.getAccountInfo(sourceAccount)) == null) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        sourceAccount,
        wallet.publicKey,
        poolVaultPDA,
        rMint
      )
    );
  }

  transaction.add(
    program.instruction.claim(
      new anchor.BN(bnAmount),
      isSol,
      {
        accounts: {
          owner: wallet.publicKey,
          pool: poolVaultPDA,
          vault: await keys.getVaultKey(),
          userPendingstate: userPendingKey,
          sourceRewardAccount: sourceAccount,
          destRewardAccount: destAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        },
      })
  );

  return true;
}

export const withdrawToken = async (wallet: any, connection: any, transaction: any, mintA: any) => {

  //console.log('start to withdraw');

  var myToken = new Token(
    connection,
    mintA,
    TOKEN_PROGRAM_ID,
    poolVaultPDA
  );

  let mintInfo = null;
  try {
    mintInfo = await myToken.getMintInfo();
  } catch (error) {
    //console.log('pool has zero balance');
    return false;
  }

  var sourceAccount = await getTokenWallet(poolVaultPDA, mintA);
  var destAccount = await getTokenWallet(wallet.publicKey, mintA);
  if ((await connection.getAccountInfo(destAccount)) == null) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        destAccount,
        wallet.publicKey,
        wallet.publicKey,
        mintA
      )
    );
  }


  let aaa = await provider.connection.getTokenAccountBalance(destAccount);
  let srcAmount = await provider.connection.getTokenAccountBalance(sourceAccount);
  let bnAmount = srcAmount.value.amount;

  //console.log('=========== before : ', srcAmount, aaa);

  transaction.add(
    program.instruction.withdrawPaidTokens(
      new anchor.BN(bnAmount),
      {
        accounts: {
          authority: wallet.publicKey,
          pool: poolVaultPDA,
          sourceAccount: sourceAccount,
          destAccount: destAccount,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
      })
  );
}

export const withdrawAllPaidTokens = async (wallet: any, connection: any, isForPayTokens: boolean) => {
  //console.log('start to withdraw');

  let transaction = new Transaction();

  if (isForPayTokens) {
    let poolInfo = await getPoolInfo(connection);
    let solAmount = await getContractSolAmount(connection);
    await withdrawSolFromContract(wallet, transaction, solAmount, true);
    await withdrawToken(wallet, connection, transaction, poolInfo.dustMint);
    await withdrawToken(wallet, connection, transaction, poolInfo.forgeMint);
  } else {
    let itemInfos = await getItemInfos();
    for (const i in itemInfos.rewardMintList) {

      let tokenList = itemInfos.rewardMintList[i];
      for (const k in tokenList) {
        await withdrawToken(wallet, connection, transaction, tokenList.itemMintList[k]);
      }
    }
  }

  await send(connection, wallet, transaction);
  // await wallet.sendTransaction(transaction, connection);
}

export const setAdminInfos = async (wallet: any, connection: any, itemInfos: []) => {
  try {
    await initialize(wallet, connection, false);
  } catch (error) {
    //console.log('admin initialize error', error);
    return false;
  }

  if (await setItemInfos(wallet, connection, itemInfos) == false) {
    //console.log('admin failed');

    return -1;
  }

  //console.log('end admin');

  return true;
}

export const getLastUsers = async (connection: any) => {
  program = getProgram(connection);
  let lastUsersKey = await keys.getLastUsersKey();
  let data = await program.account.latestUsers.fetchNullable(lastUsersKey);
  return data;
}

export const getPoolInfo = async (connection: any) => {
  program = getProgram(connection);
  poolVaultPDA = await keys.getPoolKey();

  let pool = await program.account.pool.fetchNullable(poolVaultPDA);
  return pool;
}

export const addAdmin = async (wallet: any, connection: any, adminAddr: any) => {

  let adminKey = new PublicKey(adminAddr);

  const adminListKey = await keys.getAdminInfoKey();

  let transaction = new Transaction();
  transaction.add(
    program.instruction.addAdmin(
      {
        accounts: {
          authority: wallet.publicKey,
          pool: poolVaultPDA,
          adminInfo: adminListKey,
          admin: adminKey,
        },
      }
    )
  );

  await send(connection, wallet, transaction);
}

export const deleteAdmin = async (wallet: any, connection: any, adminAddr: any) => {

  let adminKey = new PublicKey(adminAddr);

  const adminListKey = await keys.getAdminInfoKey();

  let transaction = new Transaction();
  transaction.add(
    program.instruction.deleteAdmin(
      {
        accounts: {
          authority: wallet.publicKey,
          pool: poolVaultPDA,
          adminInfo: adminListKey,
          admin: adminKey,
        },
      }
    )
  );

  await send(connection, wallet, transaction);
}


async function send(
  connection: Connection,
  wallet: WalletContextState,
  transaction: Transaction
) {
  console.log(transaction)
  const txHash = await sendTransaction(connection, wallet, transaction);
  if (txHash != null) {
    let res = await connection.confirmTransaction(txHash);
    console.log(res)
    if (res.value.err) {
      NotificationManager.error('Fronk transaction failed');
      return null;
    }
    else {
      NotificationManager.success('Fronk transaction confirmed');
    }
  } else {
    NotificationManager.error('Fronk transaction failed');
  }
  return txHash;
}


export async function sendTransaction(
  connection: Connection,
  wallet: WalletContextState,
  transaction: Transaction
) {
  if (wallet.publicKey === null || wallet.signTransaction === undefined)
    return null;
  try {
    transaction.recentBlockhash = (
      await connection.getLatestBlockhash()
    ).blockhash;
    transaction.feePayer = wallet.publicKey;
    const signedTransaction = await wallet.signTransaction(transaction);
    const rawTransaction = signedTransaction.serialize();

    const txid: TransactionSignature = await connection.sendRawTransaction(
      rawTransaction,
      {
        skipPreflight: true,
        preflightCommitment: "processed",
      }
    );
    return txid;
  } catch (e) {
    return null;
  }
}
