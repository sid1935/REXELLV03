// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessRegistry} from "./AccessRegistry.sol";
import {TicketNFT} from "./TicketNFT.sol";
import {TierPolicy} from "./Types.sol";

/**
 * Deploys one TicketNFT per event and records the terms the organizer committed
 * to.
 *
 * `policyHash` is the canonical hash of the resale terms, computed off-chain by
 * `policyHash()` in packages/db. Anchoring it at creation is what stops an
 * organizer quietly loosening a price cap after inventory has sold: the terms a
 * buyer agreed to are provable after the fact, by anyone.
 *
 * Deliberately not using EIP-1167 clones. Clones would be cheaper per event and
 * would force TicketNFT into an initialiser pattern with mutable "immutables";
 * on an L2 where a deploy costs a fraction of a cent, that is a bad trade
 * against being able to mark the trust-critical addresses `immutable`.
 */
contract EventFactory {
    error NotOrganizer();
    error EventExists(bytes32 eventId);

    event EventCreated(
        bytes32 indexed eventId,
        address indexed ticketContract,
        address indexed organizer,
        bytes32 policyHash
    );

    address public immutable admin;
    AccessRegistry public immutable registry;
    address public immutable minter;
    address public immutable gate;
    address public immutable resaleController;

    mapping(address => bool) public isOrganizer;
    mapping(bytes32 => address) public ticketContractOf;
    bytes32[] public eventIds;

    constructor(AccessRegistry registry_, address minter_, address gate_, address resaleController_) {
        admin = msg.sender;
        registry = registry_;
        minter = minter_;
        gate = gate_;
        resaleController = resaleController_;
        isOrganizer[msg.sender] = true;
    }

    function setOrganizer(address organizer, bool allowed) external {
        if (msg.sender != admin) revert NotOrganizer();
        isOrganizer[organizer] = allowed;
    }

    function createEvent(
        bytes32 eventId,
        string calldata name,
        string calldata symbol,
        bytes32 policyHash,
        uint32 capacity,
        TierPolicy[] calldata tiers
    ) external returns (address ticketContract) {
        if (!isOrganizer[msg.sender]) revert NotOrganizer();
        if (ticketContractOf[eventId] != address(0)) revert EventExists(eventId);

        // The admin is forwarded, not inherited. A TicketNFT that took its admin
        // from `msg.sender` would make this factory the admin, and this factory
        // has no function that calls revoke().
        TicketNFT deployed = new TicketNFT(
            name,
            symbol,
            admin,
            minter,
            gate,
            resaleController,
            registry,
            policyHash,
            capacity,
            tiers
        );

        ticketContract = address(deployed);
        ticketContractOf[eventId] = ticketContract;
        eventIds.push(eventId);

        emit EventCreated(eventId, ticketContract, msg.sender, policyHash);
    }

    function eventCount() external view returns (uint256) {
        return eventIds.length;
    }
}
