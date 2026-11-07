package com.example.towerdefense;

import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraftforge.registries.DeferredRegister;
import net.minecraftforge.registries.ForgeRegistries;
import net.minecraftforge.registries.RegistryObject;

public class ModBlocks {
    public static final DeferredRegister<Block> BLOCKS =
        DeferredRegister.create(ForgeRegistries.BLOCKS, TowerDefenseMod.MOD_ID);
    public static final DeferredRegister<Item> ITEMS =
        DeferredRegister.create(ForgeRegistries.ITEMS, TowerDefenseMod.MOD_ID);
    public static final DeferredRegister<BlockEntityType<?>> BLOCK_ENTITIES =
        DeferredRegister.create(ForgeRegistries.BLOCK_ENTITY_TYPES, TowerDefenseMod.MOD_ID);

    public static final RegistryObject<Block> ARROW_TOWER = BLOCKS.register("arrow_tower",
        () -> new TowerBlock(BlockBehaviour.Properties.of().strength(3f).noOcclusion()));

    public static final RegistryObject<Item> ARROW_TOWER_ITEM = ITEMS.register("arrow_tower",
        () -> new BlockItem(ARROW_TOWER.get(), new Item.Properties()));

    public static final RegistryObject<BlockEntityType<TowerBlockEntity>> TOWER_BE =
        BLOCK_ENTITIES.register("tower",
            () -> BlockEntityType.Builder.of(TowerBlockEntity::new, ARROW_TOWER.get()).build(null));
}
