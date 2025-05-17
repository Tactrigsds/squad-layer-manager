drop procedure if exists select_layers_weightedrandom;
delimiter //
CREATE procedure select_layers_weightedrandom(
    IN p_condition VARCHAR(1000),
    IN num_layers INT
)
BEGIN
    DECLARE done INT DEFAULT FALSE;
    DECLARE colname VARCHAR(255);
    DECLARE column_ordinal INT;
    DECLARE col_cursor CURSOR FOR
        SELECT column_name, ordinal
        FROM layer_column_order
        ORDER BY ordinal;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    drop temporary table if exists dbg;
    create temporary table dbg
   (
        msg varchar(4096)
    );

    drop temporary table if exists all_values;
    set @sql = concat('create temporary table all_values as (
        with all_layers as (select * from layers where ',  p_condition,')
        select ''Map'' as column_name, Map as value from all_layers group by Map
        union all
        select ''Gamemode'' as column_name, Gamemode as value from all_layers group by Gamemode
        union all
        select ''Layer'' as column_name, Layer as value from all_layers group by Layer
        union all
        select  ''Faction1'' as column_name, Faction1 as value from all_layers group by Faction1
        union all
        select  ''Faction2'' as column_name, Faction2 as value from all_layers group by Faction2
        union all
        select  ''SubFac1'' as column_name, SubFac1 as value from all_layers group by SubFac1
        union all
        select  ''SubFac2'' as column_name, SubFac2 as value from all_layers group by SubFac2
    )');
    insert into dbg (msg) values (concat('SQL: ', @sql, ' ', p_condition));
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;


-- Create results table
    DROP TEMPORARY TABLE IF EXISTS results;
    CREATE TEMPORARY TABLE results
    (
        id VARCHAR(255)
    );

    -- Loop for num_layers times
    WHILE num_layers > 0
        DO
            -- Clone temp_layers for this iteration
            DROP TEMPORARY TABLE IF EXISTS remaining_values;
            CREATE TEMPORARY TABLE remaining_values as
            select * from all_values;

-- Process each column in order
            OPEN col_cursor;
            col_loop:
            LOOP
                FETCH col_cursor INTO colname, column_ordinal;
                insert into dbg (msg) values (concat('Processing column: ', coalesce(colname, '<empty>')));
                IF done THEN
                    LEAVE col_loop;
                END IF;

                -- Check if there are any remaining rows
                -- SET @count = 0;
                -- SELECT COUNT(*) INTO @count FROM temp_layers_cloned;

                -- IF @count = 0 THEN
                --     -- No more rows, break the loop
                --     LEAVE col_loop;
                -- END IF;

                drop temporary table if exists weights_map;
                create temporary table weights_map as (select remaining_values.value      as value,
                                                              COALESCE(weights.weight, 1) as weight
                                                       from remaining_values
                                                                left join weights
                                                                          on weights.value = remaining_values.value and
                                                                             weights.column_name =
                                                                             remaining_values.column_name
                                                       where remaining_values.column_name = colname);

                SET @selected_value = select_from_weights_map();
                if @selected_value is null then
                    insert into dbg (msg) values (concat('No value found for column: ', coalesce(colname, '<empty>')));
                    leave col_loop;
                end if;

                drop temporary table if exists rem_values_map;
                create temporary table rem_values_map as (select value from remaining_values where column_name = 'Map');
                drop temporary table if exists rem_values_gamemode;
                create temporary table rem_values_gamemode as (select value from remaining_values where column_name = 'Gamemode');
                drop temporary table if exists rem_values_layer;
                create temporary table rem_values_layer as (select value from remaining_values where column_name = 'Layer');
                drop temporary table if exists rem_values_faction1;
                create temporary table rem_values_faction1 as (select value from remaining_values where column_name = 'Faction');
                drop temporary table if exists rem_values_faction2;
                create temporary table rem_values_faction2 as (select value from remaining_values where column_name = 'Faction');
                drop temporary table if exists rem_values_subfac1;
                create temporary table rem_values_subfac1 as (select value from remaining_values where column_name = 'SubFac1');
                drop temporary table if exists rem_values_subfac2;
                create temporary table rem_values_subfac2 as (select value from remaining_values where column_name = 'SubFac2');

                set @first_value = NULL;
                set @sql = CONCAT('select id into @first_value from layers where ', p_condition,
                                  ' and Map in (select value from rem_values_map)
                                    and Gamemode in (select value from rem_values_gamemode)
                                    and Layer in (select value from rem_values_layer)
                                    and (Faction1 in (select value from rem_values_faction) or
                                          Faction2 in (select value from rem_values_faction))
                                    and (SubFac1 in (select value from rem_values_subfac) or
                                            SubFac2 in (select value from rem_values_subfac))
                                    and  ', colname, ' = @selected_value
                  limit 1
                ');
                PREPARE stmt FROM @sql;
                execute stmt;
                DEALLOCATE PREPARE stmt;

                if @first_value is null then
                    insert into dbg (msg) values (concat('No value found for column: ', coalesce(colname, '<empty>')));
                    leave col_loop;
                end if;
                delete from remaining_values where column_name = colname and value != @selected_value;
            END LOOP;
            CLOSE col_cursor;
            SET done = FALSE;
            -- Reset for next iteration

            drop temporary table if exists rem_values_map;
            create temporary table rem_values_map as (select value from remaining_values where column_name = 'Map');
            drop temporary table if exists rem_values_gamemode;
            create temporary table rem_values_gamemode as (select value from remaining_values where column_name = 'Gamemode');
            drop temporary table if exists rem_values_layer;
            create temporary table rem_values_layer as (select value from remaining_values where column_name = 'Layer');
            drop temporary table if exists rem_values_faction;
            create temporary table rem_values_faction as (select value from remaining_values where column_name = 'Faction');
            drop temporary table if exists rem_values_subfac;
            create temporary table rem_values_subfac as (select value from remaining_values where column_name = 'SubFac');

            -- Select a random layer from the remaining set and add to results


            set @selected_id = NULL;
            set @sql = CONCAT('select id into @selected_id from layers where ', p_condition,
                              ' and Map in (select value from rem_values_map)
                                and Gamemode in (select value from rem_values_gamemode)
                                and Layer in (select value from rem_values_layer)
                                and (Faction1 in (select value from rem_values_faction) or
                                      Faction2 in (select value from rem_values_faction))
                                and (SubFac1 in (select value from rem_values_subfac) or
                                        SubFac2 in (select value from rem_values_subfac))
                                and id not in (select id from results)
                                and NOT EXISTS (
                                    SELECT 1
                                    FROM results r
                                    JOIN layers rl ON r.id = rl.id
                                    WHERE (
                                        (layers.Map = rl.Map) +
                                        (layers.Gamemode = rl.Gamemode) +
                                        (layers.Version = rl.Version) +
                                        (layers.Faction1 = rl.Faction1) +
                                        (layers.Faction2 = rl.Faction2) +
                                        (layers.SubFac1 = rl.SubFac1) +
                                        (layers.SubFac2 = rl.SubFac2)
                                    ) > 4
                                )
                                order by rand()
                                limit 1');
            PREPARE stmt FROM @sql;
            execute stmt;
            DEALLOCATE PREPARE stmt;

            -- If no layer found with less than 4 matching columns, accept any layer
            IF @selected_id IS NULL THEN
                set @sql = CONCAT('select id into @selected_id from layers where ', p_condition,
                                ' and Map in (select value from rem_values_map)
                                    and Gamemode in (select value from rem_values_gamemode)
                                    and Layer in (select value from rem_values_layer)
                                    and (Faction1 in (select value from rem_values_faction) or
                                          Faction2 in (select value from rem_values_faction))
                                    and (SubFac1 in (select value from rem_values_subfac) or
                                            SubFac2 in (select value from rem_values_subfac))
                                    and id not in (select id from results)
                                    order by rand()
                                    limit 1');
                PREPARE stmt FROM @sql;
                execute stmt;
                DEALLOCATE PREPARE stmt;
            END IF;

            INSERT INTO results (id) VALUES (@selected_id);

            SET num_layers = num_layers - 1;
        END WHILE;

    select id from results;
#     DROP TEMPORARY TABLE IF EXISTS results;
END //
delimiter  ;


drop function if exists select_from_weights_map;
create function select_from_weights_map()
    returns varchar(255)
    reads sql data
begin
    DECLARE done INT DEFAULT FALSE;
    declare curr_weight float;
    declare curr_value varchar(255);
    declare cum_weight float;
    declare target_weight float;
    declare total_weight float;
    declare weight_cursor cursor for select weight,value from weights_map;
    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = TRUE;

    select sum(weight) into total_weight from weights_map;

    set target_weight = rand() * total_weight;
    insert into dbg (msg) values (concat('Target weight: ', target_weight));


    set curr_weight = 0;
    open weight_cursor;

    weight_loop:
    loop
        fetch weight_cursor into curr_weight, curr_value;
        if done then
            leave weight_loop;
        end if;
        set cum_weight = curr_weight + cum_weight;
        if cum_weight >= target_weight then
            return curr_value;
        end if;
    end loop;

    return null;
end;
